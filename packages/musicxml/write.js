// Note events → MusicXML 4.0 score-partwise. See the MusicXML 4.0 spec
// (W3C Music Notation Community Group, https://www.w3.org/2021/06/musicxml40/) for element
// semantics; <note> child order below follows the spec's content model.

import quantizeNotes, { timeToBeat } from './quantize.js'
import spellFactory, { resolveKey, diatonicAlters } from './spell.js'
import { decompose, computeDivisions } from './rhythm.js'
import toMeasures from './measures.js'
import { el, serialize } from './xml.js'
import { percussionEntry, percussionMidi } from './percussion.js'
import { normalizeParts } from './parts.js'

function median (xs) {
	if (!xs.length) return 60
	let s = [...xs].sort((a, b) => a - b)
	let mid = s.length >> 1
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function resolveClef (part, qnotes) {
	if (part.percussion || part.clef === 'percussion') return 'percussion'
	if (part.clef === 'treble' || part.clef === 'bass' || part.clef === 'grand') return part.clef
	return median(qnotes.map(n => n.midi)) >= 60 ? 'treble' : 'bass'
}

function clefElements (clef) {
	if (clef === 'percussion') return [el('clef', {}, [el('sign', {}, 'percussion'), el('line', {}, '2')])]
	if (clef === 'bass') return [el('clef', {}, [el('sign', {}, 'F'), el('line', {}, '4')])]
	if (clef === 'grand') return [
		el('clef', { number: 1 }, [el('sign', {}, 'G'), el('line', {}, '2')]),
		el('clef', { number: 2 }, [el('sign', {}, 'F'), el('line', {}, '4')]),
	]
	return [el('clef', {}, [el('sign', {}, 'G'), el('line', {}, '2')])]
}

/** Piecewise tempo breakpoints (beats), snapped to the nearest measure edge → { measureIndex: bpm }. */
function tempoByMeasure (bpm, tempos, edges) {
	let map = new Map([[0, tempos?.length ? tempos[0].bpm : bpm]])
	if (!tempos?.length) return map
	let toBeat = timeToBeat(bpm, tempos)
	for (let t of tempos) {
		if (t.time <= 0) continue
		let beat = toBeat(t.time)
		let nearest = 0, best = Infinity
		for (let i = 1; i < edges.length; i++) {
			let d = Math.abs(edges[i] - beat)
			if (d < best) { best = d; nearest = i }
		}
		map.set(nearest, t.bpm)
	}
	return map
}

/** duration/tie/type/dot/time-modification children shared by pitched notes and rests. */
function durationChildren (seg, divisions, tieStart, tieStop) {
	let ticks = Math.max(1, Math.round(seg.beats * divisions))
	let kids = [el('duration', {}, String(ticks))]
	if (tieStart) kids.push(el('tie', { type: 'start' }))
	if (tieStop) kids.push(el('tie', { type: 'stop' }))
	return { ticks, kids }
}

/** Tuplet bracket start/stop per event: a bracket spans a run of adjacent, same-ratio events. */
function tupletBrackets (events) {
	return events.map((ev, i) => {
		if (!ev.tuplet) return null
		let prev = events[i - 1], next = events[i + 1]
		let adjacent = (a, b) => a && b && Math.abs(a.beat + a.beats - b.beat) < 1e-6
		let sameRun = (a, b) => a?.tuplet && b?.tuplet && a.tuplet.unit === b.tuplet.unit && adjacent(a, b)
		return { start: !sameRun(prev, ev), stop: !sameRun(ev, next) }
	})
}

function typeChildren (seg) {
	let kids = [el('type', {}, seg.type)]
	for (let i = 0; i < seg.dots; i++) kids.push(el('dot'))
	return kids
}

function notationsEl (tieStart, tieStop, tuplet, tupletPos) {
	let kids = []
	if (tieStop) kids.push(el('tied', { type: 'stop' }))
	if (tieStart) kids.push(el('tied', { type: 'start' }))
	if (tuplet && tupletPos === 'start') kids.push(el('tuplet', { type: 'start', 'bracket': 'yes' }))
	if (tuplet && tupletPos === 'stop') kids.push(el('tuplet', { type: 'stop' }))
	return kids.length ? [el('notations', {}, kids)] : []
}

/**
 * Emit the <note> elements for one voice-timeline event (chord, single note, or rest),
 * decomposing beats into a tied run where the raw duration isn't directly expressible.
 */
function eventNotes ({ event, voiceNum, divisions, spellFn, clef, accState, keyAlters, percMap, bracket }) {
	let notes = []
	if (event.rest) {
		if (event.wholeMeasure) {
			let ticks = Math.max(1, Math.round(event.beats * divisions))
			notes.push(el('note', {}, [el('rest', { measure: 'yes' }), el('duration', {}, String(ticks)), el('voice', {}, String(voiceNum))]))
			return notes
		}
		let segs = decompose(event.beats)
		for (let seg of segs) {
			let { kids: durKids } = durationChildren(seg, divisions, false, false)
			notes.push(el('note', {}, [
				el('rest'),
				...durKids,
				el('voice', {}, String(voiceNum)),
				...typeChildren(seg),
			]))
		}
		return notes
	}

	let segs = decompose(event.beats)
	segs.forEach((seg, si) => {
		let segTieStart = si < segs.length - 1 || !!event.tie?.start
		let segTieStop = si > 0 || !!event.tie?.stop
		event.notes.forEach((n, ni) => {
			let pitchOrUnpitched
			if (percMap) {
				let entry = percussionEntry(n) ?? { step: 'C', octave: 5, notehead: 'normal' }
				pitchOrUnpitched = [el('unpitched', {}, [el('display-step', {}, entry.step), el('display-octave', {}, String(entry.octave))])]
			} else {
				let { step, alter, octave } = spellFn(n.midi)
				let key = `${step}${octave}`
				let prior = accState.has(key) ? accState.get(key) : keyAlters[step]
				let showAcc = prior !== alter
				accState.set(key, alter)
				pitchOrUnpitched = [el('pitch', {}, [el('step', {}, step), ...(alter ? [el('alter', {}, String(alter))] : []), el('octave', {}, String(octave))])]
				n._accidental = showAcc ? (alter === 0 ? 'natural' : alter > 0 ? (alter === 2 ? 'double-sharp' : 'sharp') : (alter === -2 ? 'flat-flat' : 'flat')) : null
			}
			let { kids: durKids } = durationChildren(seg, divisions, segTieStart, segTieStop)
			let kids = []
			if (ni > 0) kids.push(el('chord'))
			kids.push(...pitchOrUnpitched, ...durKids, el('voice', {}, String(voiceNum)), ...typeChildren(seg))
			if (!percMap && n._accidental) kids.push(el('accidental', {}, n._accidental))
			if (seg.tuplet) kids.push(el('time-modification', {}, [el('actual-notes', {}, String(seg.tuplet.actual)), el('normal-notes', {}, String(seg.tuplet.normal))]))
			if (percMap) {
				let entry = percussionEntry(n)
				if (entry && entry.notehead !== 'normal') kids.push(el('notehead', {}, entry.notehead))
			}
			if (clef === 'grand') kids.push(el('staff', {}, n.midi >= 60 ? '1' : '2'))
			// tuplet bracket spans the whole run of adjacent same-ratio events (event-level,
			// not per decomposed segment) — start on the run's first note, stop on its last
			let tupletPos = seg.tuplet && si === 0 && bracket?.start ? 'start'
				: seg.tuplet && si === segs.length - 1 && bracket?.stop ? 'stop' : null
			kids.push(...notationsEl(segTieStart, segTieStop, seg.tuplet, tupletPos))
			notes.push(el('note', {}, kids))
		})
	})
	return notes
}

/**
 * @param {Array|{parts:Array}} input — flat notes (seconds) or { parts: [{name, notes, instrument?, percussion?, clef?}] }
 * @param {object} [opts]
 * @returns {string} MusicXML 4.0 (score-partwise) document
 */
export default function write (input, opts = {}) {
	let {
		bpm = 120, tempos, timeSignature = [4, 4], key = 0, mode = 'major',
		divisions: divisionsOpt = 480, quantize: grid = 16, triplets = true, minDuration,
		title, composer, software = '@audio/musicxml', pickup = false,
	} = opts

	let parts = normalizeParts(input)
	let [tsNum, tsDen] = timeSignature
	let beatsPerMeasure = tsNum * 4 / tsDen
	let { fifths } = resolveKey(key, mode)
	let divisions = computeDivisions([1 / 48], divisionsOpt) // 48 = LCM of rhythm.js's table denominators

	let layouts = parts.map((p, pi) => {
		let percMap = !!(p.percussion || p.clef === 'percussion')
		// mir-drums-style {type} notes carry no `midi` — resolve it via the GM map up front
		let notes = percMap ? p.notes.map(n => n.midi != null ? n : { ...n, midi: percussionMidi(n) }) : p.notes
		let qnotes = quantizeNotes(notes, { bpm, tempos, grid, triplets, minDuration })
		let { measures, edges } = toMeasures(qnotes, { beatsPerMeasure, pickup })
		let clef = resolveClef(p, qnotes)
		let spellFn = percMap ? null : spellFactory(fifths, mode)
		return { part: p, id: `P${pi + 1}`, measures, edges, clef, percMap, spellFn }
	})

	let tempoMap = tempoByMeasure(bpm, tempos, layouts[0]?.edges ?? [0, beatsPerMeasure])

	// ── part-list ──
	let scoreParts = layouts.map(({ part, id }, pi) => {
		let kids = [el('part-name', {}, part.name || `Part ${pi + 1}`)]
		if (part.instrument) {
			let iid = `${id}-I1`
			if (part.instrument.name) kids.push(el('score-instrument', { id: iid }, [el('instrument-name', {}, part.instrument.name)]))
			let midiKids = []
			let channel = part.instrument.channel ?? (part.percussion ? 9 : undefined)
			if (channel != null) midiKids.push(el('midi-channel', {}, String(channel + 1)))
			if (part.instrument.program != null) midiKids.push(el('midi-program', {}, String(part.instrument.program + 1)))
			if (midiKids.length) kids.push(el('midi-instrument', { id: iid }, midiKids))
		}
		return el('score-part', { id }, kids)
	})

	let keyAlters = diatonicAlters(fifths)
	let percKeyAlters = diatonicAlters(0)

	// ── each part's measures ──
	let partEls = layouts.map(({ part, id, measures, edges, clef, percMap, spellFn }) => {
		let accState = new Map() // per-measure — cleared at the top of every measure below
		let measureEls = measures.map((measure, mi) => {
			let kids = []
			accState.clear() // accidentals are measure-scoped
			if (mi === 0) {
				let attrKids = [el('divisions', {}, String(divisions))]
				attrKids.push(el('key', {}, [el('fifths', {}, String(percMap ? 0 : fifths)), ...(mode === 'minor' && !percMap ? [el('mode', {}, 'minor')] : [])]))
				attrKids.push(el('time', {}, [el('beats', {}, String(tsNum)), el('beat-type', {}, String(tsDen))]))
				if (clef === 'grand') attrKids.push(el('staves', {}, '2'))
				attrKids.push(...clefElements(clef))
				kids.push(el('attributes', {}, attrKids))
			}

			if (tempoMap.has(mi)) {
				let t = tempoMap.get(mi)
				kids.push(el('direction', { placement: 'above' }, [
					el('direction-type', {}, [el('metronome', {}, [el('beat-unit', {}, 'quarter'), el('per-minute', {}, String(t))])]),
					el('sound', { tempo: String(t) }),
				]))
			}

			let measureTicks = Math.round((edges[mi + 1] - edges[mi]) * divisions)
			measure.voices.forEach((voiceEvents, vi) => {
				if (vi > 0) kids.push(el('backup', {}, [el('duration', {}, String(measureTicks))]))
				let brackets = tupletBrackets(voiceEvents)
				voiceEvents.forEach((event, ei) => {
					kids.push(...eventNotes({ event, voiceNum: vi + 1, divisions, spellFn, clef, accState, keyAlters: percMap ? percKeyAlters : keyAlters, percMap, bracket: brackets[ei] }))
				})
			})
			return el('measure', { number: String(mi + 1) }, kids)
		})
		return el('part', { id }, measureEls)
	})

	let identKids = [el('encoding', {}, [el('software', {}, software)])]
	if (composer) identKids.unshift(el('creator', { type: 'composer' }, composer))

	let root = el('score-partwise', { version: '4.0' }, [
		...(title ? [el('work', {}, [el('work-title', {}, title)])] : []),
		el('identification', {}, identKids),
		el('part-list', {}, scoreParts),
		...partEls,
	])

	return serialize(root, { doctype: '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' })
}
