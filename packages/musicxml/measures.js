// Quantized notes (one part, beat-grid) → measures of voices, each voice a gapless timeline of
// note/chord/rest events that fills every measure exactly. Shared by the MusicXML and ABC
// writers so voice assignment, barline splitting and tying are implemented exactly once.
//
// Voices are how notation holds overlapping notes on one staff (MusicXML 4.0 <voice>, <backup>,
// <chord/>, https://www.w3.org/2021/06/musicxml40/; ABC 2.1 §7 V:,
// https://abcnotation.com/wiki/abc:standard:v2.1): within one voice notes follow each other,
// and notes sharing onset and end sound together as one chord. Assignment is greedy by onset,
// highest pitch first: a note joins the chord a voice holds with the same onset and end (one
// notehead per pitch), else takes the free voice whose last pitch is nearest (lowest number on
// a tie), else opens a new voice. A voice opens only while every other one still sounds, so a
// part has as many voices as it has chords sounding at once (greedy interval partitioning).
// A note crossing a barline is cut there and tied, and keeps its voice.

const EPS = 1e-6

/** Measure-start beat positions (length = measure count + 1); pickup shortens measure 0. */
export function measureEdges (maxBeat, beatsPerMeasure, pickup = false) {
	let full = Math.max(1, Math.ceil((maxBeat - EPS) / beatsPerMeasure))
	if (!pickup) {
		let edges = [0]
		for (let i = 0; i < full; i++) edges.push((i + 1) * beatsPerMeasure)
		return edges
	}
	let pickupLen = maxBeat % beatsPerMeasure
	if (pickupLen < EPS) return measureEdges(maxBeat, beatsPerMeasure, false)
	let n = Math.max(1, Math.ceil((maxBeat - pickupLen - EPS) / beatsPerMeasure))
	let edges = [0, pickupLen]
	for (let i = 0; i < n; i++) edges.push(pickupLen + (i + 1) * beatsPerMeasure)
	return edges
}

const near = (a, b) => Math.abs(a - b) < EPS

/** Split one part's notes into voice timelines of non-overlapping {beat, beats, notes, tuplet} events. */
function splitVoices (notes) {
	let voices = [] // event lists; a voice's last event says whether it still sounds
	let order = [...notes].sort((a, b) => a.beat - b.beat || b.midi - a.midi || b.beats - a.beats)
	for (let n of order) {
		let end = n.beat + n.beats
		let chord = voices.find(v => {
			let ev = v[v.length - 1]
			return near(ev.beat, n.beat) && near(ev.beat + ev.beats, end) && !ev.notes.some(m => m.midi === n.midi)
		})
		if (chord) { chord[chord.length - 1].notes.push(n); continue }
		let free = null, dist = Infinity
		for (let v of voices) {
			let ev = v[v.length - 1]
			if (ev.beat + ev.beats > n.beat + EPS) continue // still sounding
			let d = Math.min(...ev.notes.map(m => Math.abs(m.midi - n.midi)))
			if (d < dist) { free = v; dist = d }
		}
		if (!free) voices.push(free = [])
		free.push({ beat: n.beat, beats: n.beats, notes: [n], tuplet: n.tuplet })
	}
	for (let v of voices) for (let ev of v) ev.notes.sort((a, b) => a.midi - b.midi)
	return voices.length ? voices : [[]]
}

/** Cut [beat, beat+beats) at every measure edge it crosses. */
function splitAtEdges (beat, beats, edges) {
	let segs = []
	let end = beat + beats
	let pos = beat
	let mIdx = edges.findIndex((e, i) => i < edges.length - 1 && pos < edges[i + 1] - EPS)
	while (pos < end - EPS) {
		let measureEnd = edges[mIdx + 1]
		let segEnd = Math.min(end, measureEnd)
		segs.push({ beat: pos, beats: segEnd - pos, measure: mIdx })
		pos = segEnd
		mIdx++
	}
	return segs
}

/** Fill [from, to) with rests: one whole-measure rest if the gap covers a full empty measure,
 *  otherwise split at each integer-beat line so no single rest spans more than one beat. */
function fillRests (measures, edges, from, to) {
	let pos = from
	let mIdx = edges.findIndex((e, i) => i < edges.length - 1 && pos < edges[i + 1] - EPS)
	while (pos < to - EPS) {
		let measureStart = edges[mIdx], measureEnd = edges[mIdx + 1]
		let atStart = Math.abs(pos - measureStart) < EPS
		let wholeMeasure = atStart && measureEnd <= to + EPS
		let segEnd = wholeMeasure ? measureEnd : Math.min(to, measureEnd, Math.floor(pos + EPS) + 1)
		measures[mIdx].push({ beat: pos - measureStart, beats: segEnd - pos, notes: [], tuplet: null, tie: null, rest: true, wholeMeasure })
		pos = segEnd
		if (pos >= measureEnd - EPS) mIdx++
	}
}

function layoutVoice (events, edges) {
	let measures = Array.from({ length: edges.length - 1 }, () => [])
	let cursor = 0
	for (let ev of events) {
		if (ev.beat > cursor + EPS) fillRests(measures, edges, cursor, ev.beat)
		let segs = splitAtEdges(ev.beat, ev.beats, edges)
		segs.forEach((seg, i) => {
			measures[seg.measure].push({
				beat: seg.beat - edges[seg.measure], beats: seg.beats, notes: ev.notes, tuplet: ev.tuplet,
				tie: segs.length > 1 ? { start: i < segs.length - 1, stop: i > 0 } : null,
			})
		})
		cursor = ev.beat + ev.beats
	}
	fillRests(measures, edges, cursor, edges[edges.length - 1])
	for (let m of measures) m.sort((a, b) => a.beat - b.beat)
	return measures
}

/**
 * @param {Array<{beat, beats, midi, velocity, tuplet}>} notes — one part, quantize() output
 * @param {object} opts
 * @param {number} opts.beatsPerMeasure
 * @param {boolean} [opts.pickup=false]
 * @returns {{ measures: Array<{ voices: Array<Array<{beat, beats, notes, tuplet, tie, rest}>>>}, edges: number[] }}
 *   every measure lists every voice (voice n at index n − 1), each filled with rests to the measure's length
 */
export default function toMeasures (notes, { beatsPerMeasure, pickup = false }) {
	let maxBeat = notes.reduce((m, n) => Math.max(m, n.beat + n.beats), 0)
	let edges = measureEdges(maxBeat, beatsPerMeasure, pickup)
	let laid = splitVoices(notes).map(v => layoutVoice(v, edges))
	let measures = laid[0].map((_, i) => ({ voices: laid.map(v => v[i]) }))
	return { measures, edges }
}
