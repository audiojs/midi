// Note events → ABC 2.1 (https://abcnotation.com/wiki/abc:standard:v2.1). Renders the
// primary voice per part (chords included; a second concurrent voice from unequal-duration
// overlaps — see measures.js — is not rendered, use write() for that). Reuses quantize.js
// for the beat grid and measures.js for barline splitting/tying so both writers agree on
// where notes fall and where ties are needed.

import quantizeNotes from './quantize.js'
import spellFactory, { resolveKey, diatonicAlters } from './spell.js'
import toMeasures from './measures.js'
import { normalizeParts } from './parts.js'
import { percussionEntry, percussionMidi } from './percussion.js'

/** Smallest denominator ≤ maxDen with beats*d ≈ integer (mirrors rhythm.js's helper). */
function fraction (beats, maxDen = 32) {
	for (let d = 1; d <= maxDen; d++) {
		let n = beats * d
		if (Math.abs(n - Math.round(n)) < 1e-6) return { num: Math.round(n), den: d }
	}
	return { num: Math.round(beats * maxDen), den: maxDen }
}

/** L:1/4 length suffix for a duration given in beats (1 beat = 1 quarter = 1 L-unit). */
function lengthSuffix (beats) {
	let { num, den } = fraction(beats)
	let g = (a, b) => (b === 0 ? a : g(b, a % b))
	let d0 = g(num, den) || 1
	num /= d0; den /= d0
	if (den === 1) return num === 1 ? '' : String(num)
	return num === 1 ? `/${den}` : `${num}/${den}`
}

/** midi (spelled) → ABC pitch letter with octave marks and accidental-suppression state. */
function pitchToken (step, alter, octave, accState, keyAlters) {
	let key = `${step}${octave}`
	let prior = accState.has(key) ? accState.get(key) : keyAlters[step]
	let acc = prior !== alter ? (alter === 2 ? '^^' : alter === 1 ? '^' : alter === 0 ? '=' : alter === -1 ? '_' : '__') : ''
	accState.set(key, alter)
	let letter = octave === 4 ? step : step.toLowerCase()
	let marks = octave > 5 ? "'".repeat(octave - 5) : octave < 4 ? ','.repeat(4 - octave) : ''
	return acc + letter + marks
}

/**
 * @param {Array|{parts:Array}} input
 * @param {object} [opts] — same quantization opts as write(); plus title, composer (→ C:)
 * @returns {string} ABC 2.1 tune
 */
export function toAbc (input, opts = {}) {
	let {
		bpm = 120, tempos, timeSignature = [4, 4], key = 0, mode = 'major',
		quantize: grid = 16, triplets = true, minDuration, title = 'Untitled', composer, pickup = false,
	} = opts

	let parts = normalizeParts(input)
	let [tsNum, tsDen] = timeSignature
	let beatsPerMeasure = tsNum * 4 / tsDen
	let { fifths } = resolveKey(key, mode)
	let keyName = abcKeyName(fifths, mode)

	let header = [
		'X:1',
		`T:${title}`,
		...(composer ? [`C:${composer}`] : []),
		`M:${tsNum}/${tsDen}`,
		'L:1/4',
		`Q:1/4=${bpm}`,
		`K:${keyName}`,
	]

	let bodies = parts.map((p) => {
		let percMap = !!p.percussion
		// mir-drums-style {type} notes carry no `midi` — resolve it via the GM map up front
		let notes = percMap ? p.notes.map(n => n.midi != null ? n : { ...n, midi: percussionMidi(n) }) : p.notes
		let qnotes = quantizeNotes(notes, { bpm, tempos, grid, triplets, minDuration })
		let { measures } = toMeasures(qnotes, { beatsPerMeasure, pickup })
		let spellFn = percMap ? null : spellFactory(fifths, mode)
		let keyAlters = percMap ? diatonicAlters(0) : diatonicAlters(fifths)
		let accState = new Map()
		let bars = measures.map((measure) => {
			accState.clear()
			let events = measure.voices[0] || []
			let tokens = []
			let i = 0
			while (i < events.length) {
				let ev = events[i]
				let runLen = 1
				if (ev.tuplet && !ev.rest) {
					while (i + runLen < events.length && sameTupletRun(events[i + runLen - 1], events[i + runLen])) runLen++
				}
				if (runLen >= 3) {
					tokens.push('(3' + events.slice(i, i + 3).map(e => eventToken(e)).join(''))
					i += 3
				} else {
					tokens.push(eventToken(ev))
					i += 1
				}
			}
			return tokens.join(' ')

			function eventToken (ev) {
				// tuplet notes are written at their "normal" (non-tuplet) length — the (3 marker
				// alone conveys "3 in the time of 2", e.g. an eighth-triplet (1/3 beat) is written
				// as a plain eighth ('/2'), not '/3'
				let writtenBeats = ev.tuplet ? ev.beats * ev.tuplet.actual / ev.tuplet.normal : ev.beats
				let suf = lengthSuffix(writtenBeats)
				let tie = ev.tie?.start ? '-' : ''
				if (ev.rest) return 'z' + suf
				if (percMap) {
					return ev.notes.map(n => {
						let entry = percussionEntry(n) ?? { step: 'C', octave: 5 }
						return entry.step.toLowerCase() + (entry.octave > 5 ? "'".repeat(entry.octave - 5) : '')
					}).join('') + suf + tie
				}
				let toks = ev.notes.map(n => {
					let { step, alter, octave } = spellFn(n.midi)
					return pitchToken(step, alter, octave, accState, keyAlters)
				})
				let body = toks.length > 1 ? `[${toks.join('')}]` : toks[0]
				return body + suf + tie
			}
		})
		return bars.join(' | ') + ' |]'
	})

	return header.join('\n') + '\n' + bodies.join('\n\n')
}

function sameTupletRun (a, b) {
	return a?.tuplet && b?.tuplet && a.tuplet.unit === b.tuplet.unit && Math.abs(a.beat + a.beats - b.beat) < 1e-6
}

// circle-of-fifths → ABC key names (major written plain, minor with trailing 'm')
const MAJOR_NAMES = { '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' }
const MINOR_NAMES = { '-7': 'Abm', '-6': 'Ebm', '-5': 'Bbm', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm', 0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m', 6: 'D#m', 7: 'A#m' }
function abcKeyName (fifths, mode) {
	return (mode === 'minor' ? MINOR_NAMES : MAJOR_NAMES)[String(fifths)] ?? 'C'
}
