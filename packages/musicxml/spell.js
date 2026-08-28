// Key-aware pitch spelling — MIDI number → {step, alter, octave} the way a key signature
// dictates: diatonic notes take the key's own accidental, chromatic notes are spelled
// sharp in sharp/neutral keys and flat in flat keys, and a minor key's raised 7th (the
// harmonic-minor leading tone) is spelled as a raised version of the *natural* 7th degree
// letter rather than as a flat of the letter above (traditional notation practice — see
// e.g. Gardner Read, "Music Notation", ch. on key signatures and the melodic/harmonic minor).

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F']

const MAJOR_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 }
const MINOR_FIFTHS = { A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7 }

/** 'C'|'G'|'Am'|-2|… + optional explicit mode → { fifths, mode } */
export function resolveKey (key = 0, mode) {
	if (typeof key === 'number') return { fifths: key, mode: mode ?? 'major' }
	let m = key.length > 1 && key.endsWith('m') // trailing lowercase 'm' = minor, e.g. 'Am', 'F#m'
	let root = m ? key.slice(0, -1) : key
	let tbl = (mode ?? (m ? 'minor' : 'major')) === 'minor' ? MINOR_FIFTHS : MAJOR_FIFTHS
	if (!(root in tbl)) throw new RangeError(`musicxml: unknown key "${key}"`)
	return { fifths: tbl[root], mode: mode ?? (m ? 'minor' : 'major') }
}

/** Diatonic letter → alter map for a key signature (fifths −7..7). */
export function diatonicAlters (fifths) {
	let alter = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 }
	if (fifths > 0) for (let i = 0; i < fifths; i++) alter[SHARP_ORDER[i]] = 1
	else if (fifths < 0) for (let i = 0; i < -fifths; i++) alter[FLAT_ORDER[i]] = -1
	return alter
}

/** fifths (+ major/minor) → tonic letter index into LETTERS (0=C..6=B). */
function tonicLetterIndex (fifths, mode) {
	let majorIdx = (((fifths * 4) % 7) + 7) % 7
	return mode === 'minor' ? (majorIdx + 5) % 7 : majorIdx
}

/**
 * Build a spelling function for a key. Returns (midi) → { step, alter, octave }.
 * `alter` is the accidental relative to natural (−1 flat, 0 natural, +1 sharp).
 */
export default function spell (key = 0, mode) {
	let { fifths, mode: m } = resolveKey(key, mode)
	let alters = diatonicAlters(fifths)
	// pc → {letter, alter} for the 7 diatonic pitch classes
	let diatonicByPc = new Map()
	for (let L of LETTERS) diatonicByPc.set(((BASE[L] + alters[L]) % 12 + 12) % 12, { letter: L, alter: alters[L] })

	// minor: raised 7th (leading tone) spelling — same letter as the natural 7th, alter+1
	let raisedSeventh = null
	if (m === 'minor') {
		let tonicIdx = tonicLetterIndex(fifths, 'minor')
		let seventhLetter = LETTERS[(tonicIdx - 1 + 7) % 7]
		let pc = ((BASE[seventhLetter] + alters[seventhLetter] + 1) % 12 + 12) % 12
		raisedSeventh = { pc, letter: seventhLetter, alter: alters[seventhLetter] + 1 }
	}

	return function (midi) {
		let m0 = Math.round(midi)
		let pc = ((m0 % 12) + 12) % 12
		let octaveFor = (letter, alter) => Math.floor((m0 - alter - BASE[letter]) / 12) - 1

		if (raisedSeventh && pc === raisedSeventh.pc) {
			return { step: raisedSeventh.letter, alter: raisedSeventh.alter, octave: octaveFor(raisedSeventh.letter, raisedSeventh.alter) }
		}
		let d = diatonicByPc.get(pc)
		if (d) return { step: d.letter, alter: d.alter, octave: octaveFor(d.letter, d.alter) }

		// natural cancellation: the note is the *unaltered* letter the key signature itself
		// sharps/flats (e.g. F-natural in G major) — respell that letter natural, not a neighbour
		for (let L of LETTERS) {
			if (alters[L] !== 0 && BASE[L] === pc) return { step: L, alter: 0, octave: octaveFor(L, 0) }
		}

		// chromatic: sharp of the letter below in sharp/neutral keys, flat of the letter above in flat keys
		let sharp = null, flat = null
		for (let [dpc, d1] of diatonicByPc) {
			if ((dpc + 1) % 12 === pc) sharp = { step: d1.letter, alter: d1.alter + 1 }
			if ((dpc - 1 + 12) % 12 === pc) flat = { step: d1.letter, alter: d1.alter - 1 }
		}
		let pick = fifths >= 0 ? (sharp ?? flat) : (flat ?? sharp)
		return { step: pick.step, alter: pick.alter, octave: octaveFor(pick.step, pick.alter) }
	}
}
