// MusicXML 4.0 → note events. Handles score-partwise and score-timewise (the latter is
// converted to a partwise element tree first), <backup>/<forward>, chords, ties (via <tie>
// or, when absent, <notations><tied>), dotted/tuplet durations (already resolved by the
// <duration> element — no rhythm decoding needed on read), and piecewise tempo from
// <sound tempo> / <direction><metronome>. Transposing instruments (<attributes><transpose>)
// are not un-transposed — pitches are read as literally written; see README.

import { parse as parseXml, child, children, text, num } from './xml.js'
import { percussionByDisplay } from './percussion.js'

const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function timewiseToPartwise (root) {
	let byPart = new Map()
	for (let measure of children(root, 'measure')) {
		let mNum = measure.attrs.number
		for (let part of children(measure, 'part')) {
			let id = part.attrs.id
			if (!byPart.has(id)) byPart.set(id, [])
			byPart.get(id).push({ tag: 'measure', attrs: { number: mNum }, children: part.children, text: '' })
		}
	}
	let parts = [...byPart.entries()].map(([id, measures]) => ({ tag: 'part', attrs: { id }, children: measures, text: '' }))
	return { tag: 'score-partwise', attrs: root.attrs, children: [child(root, 'part-list'), ...parts].filter(Boolean), text: '' }
}

/** beat breakpoints (sorted, deduped) → cumulative-time function, mirrors quantize.js's inverse. */
function makeBeatToTime (points) {
	let pts = [...points].sort((a, b) => a.beat - b.beat)
	if (!pts.length || pts[0].beat > 0) pts = [{ beat: 0, bpm: pts[0]?.bpm ?? 120 }, ...pts]
	let timeAcc = [0]
	for (let i = 1; i < pts.length; i++) timeAcc.push(timeAcc[i - 1] + (pts[i].beat - pts[i - 1].beat) * 60 / pts[i - 1].bpm)
	return (beat) => {
		let i = 0
		while (i + 1 < pts.length && pts[i + 1].beat <= beat) i++
		return timeAcc[i] + (beat - pts[i].beat) * 60 / pts[i].bpm
	}
}

function pitchMidi (pitchEl) {
	let step = text(pitchEl, 'step')
	let alter = num(pitchEl, 'alter', 0)
	let octave = num(pitchEl, 'octave', 4)
	return (octave + 1) * 12 + BASE[step] + alter
}

function hasTie (noteEl, kind) {
	if (children(noteEl, 'tie').some(t => t.attrs.type === kind)) return true
	let notations = child(noteEl, 'notations')
	if (notations && children(notations, 'tied').some(t => t.attrs.type === kind)) return true
	return false
}

/** Parse one <part> element into a flat note list + the tempo breakpoints it declared. */
function readPart (partEl) {
	let divisions = 1
	let notes = []
	let tempoPoints = []
	let openTies = new Map() // `${voice}:${midi}` → note object still open for continuation
	let positionBeats = 0
	let fifths = 0, mode = 'major', timeSignature = [4, 4]

	let chordBaseBeats = 0 // onset shared by a run of <chord/> notes — the preceding main note's start

	for (let measure of children(partEl, 'measure')) {
		let measureStartBeats = positionBeats
		for (let node of measure.children) {
			if (node.tag === 'attributes') {
				let d = child(node, 'divisions')
				if (d) divisions = Number(d.text)
				let key = child(node, 'key')
				if (key) { fifths = num(key, 'fifths', 0); mode = text(key, 'mode', 'major') }
				let time = child(node, 'time')
				if (time) timeSignature = [num(time, 'beats', 4), num(time, 'beat-type', 4)]
			} else if (node.tag === 'direction') {
				let metronome = child(child(node, 'direction-type') ?? node, 'metronome')
				let bpm = metronome ? num(metronome, 'per-minute', null) : null
				let sound = child(node, 'sound')
				if (sound?.attrs.tempo) bpm = Number(sound.attrs.tempo)
				if (bpm != null) tempoPoints.push({ beat: positionBeats, bpm })
			} else if (node.tag === 'backup') {
				positionBeats -= Number(text(node, 'duration', 0)) / divisions
			} else if (node.tag === 'forward') {
				positionBeats += Number(text(node, 'duration', 0)) / divisions
			} else if (node.tag === 'note') {
				let ticks = Number(text(node, 'duration', 0))
				let durationBeats = ticks / divisions
				let isChord = !!child(node, 'chord')
				let voice = text(node, 'voice', '1')
				let restEl = child(node, 'rest')
				if (!isChord) chordBaseBeats = positionBeats // remember for any <chord/> siblings that follow

				if (!restEl) {
					let pitchEl = child(node, 'pitch')
					let unpitchedEl = child(node, 'unpitched')
					let midi
					if (pitchEl) midi = pitchMidi(pitchEl)
					else if (unpitchedEl) {
						let step = text(unpitchedEl, 'display-step'), octave = num(unpitchedEl, 'display-octave', 5)
						let entry = percussionByDisplay(step, octave)
						midi = entry ? entry.midi : (octave + 1) * 12 + (BASE[step] ?? 0)
					} else midi = 60

					let tieStart = hasTie(node, 'start'), tieStop = hasTie(node, 'stop')
					let noteBeat = isChord ? chordBaseBeats : positionBeats
					let key = `${voice}:${midi}`

					if (tieStop && openTies.has(key)) {
						let open = openTies.get(key)
						if (Math.abs(open._beat + open._durBeats - noteBeat) < 1e-6) {
							open._durBeats += durationBeats
							if (tieStart) openTies.set(key, open); else openTies.delete(key)
							if (!isChord) positionBeats += durationBeats
							continue
						}
					}

					let n = { time: null, _beat: noteBeat, _durBeats: durationBeats, midi, velocity: 0.8, voice: Number(voice) }
					notes.push(n)
					if (tieStart) openTies.set(key, n)
				}
				if (!isChord) positionBeats += durationBeats
			}
		}
		if (positionBeats < measureStartBeats) positionBeats = measureStartBeats // guard against malformed backups
	}

	let beatToTime = makeBeatToTime(tempoPoints.length ? tempoPoints : [{ beat: 0, bpm: 120 }])
	for (let n of notes) {
		n.time = beatToTime(n._beat)
		n.duration = beatToTime(n._beat + n._durBeats) - n.time
		delete n._beat; delete n._durBeats
	}
	notes.sort((a, b) => a.time - b.time || a.midi - b.midi)
	return { notes, fifths, mode, timeSignature, divisions, tempoPoints, beatToTime }
}

/**
 * @param {string} xml — MusicXML 4.0 (score-partwise or score-timewise)
 * @returns {{ parts: Array<{name, notes, key, timeSignature, tempos, divisions}>, title, composer }}
 */
export default function parse (xml) {
	let root = parseXml(xml)
	if (root.tag === 'score-timewise') root = timewiseToPartwise(root)
	if (root.tag !== 'score-partwise') throw new TypeError(`musicxml: unsupported root element <${root.tag}>`)

	let partList = child(root, 'part-list')
	let names = new Map(partList ? children(partList, 'score-part').map(sp => [sp.attrs.id, text(sp, 'part-name', sp.attrs.id)]) : [])

	let workEl = child(root, 'work')
	let title = workEl ? text(workEl, 'work-title') : undefined
	let ident = child(root, 'identification')
	let composer = ident ? children(ident, 'creator').find(c => c.attrs.type === 'composer')?.text : undefined

	let parts = children(root, 'part').map((partEl) => {
		let { notes, fifths, mode, timeSignature, divisions, tempoPoints, beatToTime } = readPart(partEl)
		let tempos = tempoPoints.map(p => ({ time: beatToTime(p.beat), bpm: p.bpm }))
		return {
			name: names.get(partEl.attrs.id) ?? partEl.attrs.id,
			notes: notes.map(({ time, duration, midi, velocity, voice }) => ({ time, duration, midi, velocity, voice })),
			key: { fifths, mode },
			timeSignature,
			tempos,
			divisions,
		}
	})

	return { parts, title, composer }
}
