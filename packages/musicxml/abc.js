// Note events → ABC 2.1 (https://abcnotation.com/wiki/abc:standard:v2.1), as one tune: a
// blank line ends a tune (§2.2.4), so every voice of every part is an ABC voice in the one tune
// body (§7 "Multiple voices": V:1, V:2, …), and %%score (§11.1) puts a part's voices on one
// staff. Reuses quantize.js for the beat grid and measures.js for voices, barline splitting and
// tying, so both writers agree on where notes fall; rhythm.js splits each length into notated
// values tied together, since lengths with no staff-notation value "should be avoided" (§4.3).

import quantizeNotes from './quantize.js'
import spellFactory, { resolveKey, diatonicAlters } from './spell.js'
import toMeasures from './measures.js'
import { decompose } from './rhythm.js'
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
 * @returns {string} ABC 2.1 tune, a part's overlapping notes and each further part as voices V:1, V:2, …
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

	// voices of all parts, numbered on through the parts: { id, part, name, body }
	let voices = parts.flatMap((p, pi) => {
		let percMap = !!p.percussion
		// mir-drums-style {type} notes carry no `midi` — resolve it via the GM map up front
		let notes = percMap ? p.notes.map(n => n.midi != null ? n : { ...n, midi: percussionMidi(n) }) : p.notes
		let qnotes = quantizeNotes(notes, { bpm, tempos, grid, triplets, minDuration })
		let { measures } = toMeasures(qnotes, { beatsPerMeasure, pickup })
		let spellFn = percMap ? null : spellFactory(fifths, mode)
		let keyAlters = percMap ? diatonicAlters(0) : diatonicAlters(fifths)
		return measures[0].voices.map((_, vi) => ({
			part: pi, name: vi ? null : p.name || `Part ${pi + 1}`,
			// a voice other than the first is silent where it holds no note: an invisible rest (§4.5 x)
			body: measures.map(m => barTokens(m.voices[vi], { hide: vi > 0 && m.voices[vi].every(e => e.rest), percMap, spellFn, keyAlters })).join(' | ') + ' |]',
		}))
	})
	voices.forEach((v, i) => v.id = i + 1)

	let header = [
		'X:1',
		`T:${title}`,
		...(composer ? [`C:${composer}`] : []),
		`M:${tsNum}/${tsDen}`,
		'L:1/4',
		`Q:1/4=${bpm}`,
	]
	if (voices.length === 1) return [...header, `K:${keyName}`, voices[0].body].join('\n')

	let staves = parts.map((_, pi) => voices.filter(v => v.part === pi).map(v => v.id))
	header.push('%%score ' + staves.map(ids => ids.length > 1 ? `(${ids.join(' ')})` : ids[0]).join(' '))
	for (let v of voices) header.push(`V:${v.id}` + (v.name && parts.length > 1 ? ` name="${v.name.replace(/"/g, "'")}"` : ''))
	return [...header, `K:${keyName}`, ...voices.flatMap(v => [`V:${v.id}`, v.body])].join('\n')
}

/** One bar of one voice → ABC tokens. Each event is split into notated values (tied for a
 *  note); three equal triplet values in a row share one (3, a lone one is (3:2:1 (§4.13). */
function barTokens (events, { hide, percMap, spellFn, keyAlters }) {
	let accState = new Map() // accidentals shown so far in this bar of this voice
	let pieces = events.flatMap(ev => decompose(ev.beats).map((p, i, run) => ({ ev, p, tie: !ev.rest && (i < run.length - 1 || !!ev.tie?.start) })))
	let tokens = []
	for (let i = 0; i < pieces.length;) {
		let { tuplet, beats } = pieces[i].p
		let three = tuplet && i + 2 < pieces.length && [1, 2].every(k => pieces[i + k].p.tuplet && Math.abs(pieces[i + k].p.beats - beats) < 1e-6)
		if (three) { tokens.push('(3' + pieces.slice(i, i + 3).map(token).join('')); i += 3 }
		else { tokens.push((tuplet ? '(3:2:1' : '') + token(pieces[i])); i++ }
	}
	return tokens.join(' ')

	function token ({ ev, p, tie }) {
		// a triplet value is written at its notated length, the (3 marker sounds it at 2/3
		let suf = lengthSuffix(p.tuplet ? p.beats * p.tuplet.actual / p.tuplet.normal : p.beats)
		if (ev.rest || hide) return (hide ? 'x' : 'z') + suf
		let toks = ev.notes.map(n => {
			if (percMap) {
				let entry = percussionEntry(n) ?? { step: 'C', octave: 5 }
				return entry.step.toLowerCase() + (entry.octave > 5 ? "'".repeat(entry.octave - 5) : '')
			}
			let { step, alter, octave } = spellFn(n.midi)
			return pitchToken(step, alter, octave, accState, keyAlters)
		})
		return (toks.length > 1 ? `[${toks.join('')}]` : toks[0]) + suf + (tie ? '-' : '')
	}
}

// circle-of-fifths → ABC key names (major written plain, minor with trailing 'm')
const MAJOR_NAMES = { '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' }
const MINOR_NAMES = { '-7': 'Abm', '-6': 'Ebm', '-5': 'Bbm', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm', 0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m', 6: 'D#m', 7: 'A#m' }
function abcKeyName (fifths, mode) {
	return (mode === 'minor' ? MINOR_NAMES : MAJOR_NAMES)[String(fifths)] ?? 'C'
}
