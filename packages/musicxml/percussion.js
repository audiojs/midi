// General MIDI Level 1 percussion key map (channel 10 note numbers) + the display
// step/octave convention most notation software (Finale/Sibelius/MuseScore default
// drum staff) uses to place each instrument on a 5-line percussion staff.
// GM map: MIDI Manufacturers Association, "General MIDI System Level 1", §Percussion Key Map.

export const GM_PERCUSSION = {
	kick: { midi: 36, name: 'Bass Drum 1', step: 'F', octave: 4, notehead: 'normal' },
	snare: { midi: 38, name: 'Acoustic Snare', step: 'C', octave: 5, notehead: 'normal' },
	hihat: { midi: 42, name: 'Closed Hi-Hat', step: 'G', octave: 5, notehead: 'x' },
	'hihat-open': { midi: 46, name: 'Open Hi-Hat', step: 'G', octave: 5, notehead: 'x' },
	'hihat-pedal': { midi: 44, name: 'Pedal Hi-Hat', step: 'D', octave: 5, notehead: 'x' },
	'tom-low': { midi: 41, name: 'Low Floor Tom', step: 'A', octave: 4, notehead: 'normal' },
	'tom-mid': { midi: 45, name: 'Low Tom', step: 'D', octave: 5, notehead: 'normal' },
	'tom-high': { midi: 48, name: 'Hi-Mid Tom', step: 'E', octave: 5, notehead: 'normal' },
	crash: { midi: 49, name: 'Crash Cymbal 1', step: 'A', octave: 5, notehead: 'x' },
	ride: { midi: 51, name: 'Ride Cymbal 1', step: 'F', octave: 5, notehead: 'x' },
}

const BY_MIDI = new Map(Object.values(GM_PERCUSSION).map(v => [v.midi, v]))
// first-wins: several GM instruments share a staff position (e.g. closed/open hi-hat both
// sit on G5) — the earlier, more common entry above wins the reverse lookup on parse
const BY_DISPLAY = new Map()
for (let v of Object.values(GM_PERCUSSION)) { let k = `${v.step}${v.octave}`; if (!BY_DISPLAY.has(k)) BY_DISPLAY.set(k, v) }

/** MusicXML <unpitched> display-step/display-octave → GM percussion entry (or null). */
export function percussionByDisplay (step, octave) {
	return BY_DISPLAY.get(`${step}${octave}`) ?? null
}

/** mir-drums-style {type} → GM percussion entry, or by raw MIDI channel-10 number. */
export function percussionEntry (note) {
	if (note.type != null && GM_PERCUSSION[note.type]) return GM_PERCUSSION[note.type]
	if (note.midi != null && BY_MIDI.has(Math.round(note.midi))) return BY_MIDI.get(Math.round(note.midi))
	return null
}

/** midi note number for a percussion input note (type-keyed or already numeric). */
export function percussionMidi (note) {
	if (note.midi != null) return note.midi
	let e = GM_PERCUSSION[note.type]
	if (!e) throw new RangeError(`musicxml: unknown percussion type "${note.type}"`)
	return e.midi
}
