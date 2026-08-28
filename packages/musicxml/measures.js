// Quantized notes (one part, beat-grid) → measures of up to 2 voices, each voice a gapless
// timeline of note/chord/rest events. Shared by the MusicXML and ABC writers so barline
// splitting, tying, and voice assignment are implemented exactly once.
//
// Voice assignment: notes sharing an onset (a "chord") split by duration into classes; the
// largest class is voice 1 (marked with MusicXML <chord/> on the 2nd+ pitch), any other
// duration class at that onset goes to voice 2 (<backup> in the MusicXML writer). A note
// whose span crosses a measure boundary is cut at the barline and tied.

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

function groupByOnset (notes) {
	let groups = []
	for (let n of notes) {
		let g = groups[groups.length - 1]
		if (g && Math.abs(g.beat - n.beat) < EPS) g.notes.push(n)
		else groups.push({ beat: n.beat, notes: [n] })
	}
	return groups
}

/** Split one part's notes into up to 2 voice timelines of {beat, beats, notes, tuplet} events. */
function splitVoices (notes) {
	let v1 = [], v2 = []
	for (let g of groupByOnset(notes)) {
		let byDur = new Map()
		for (let n of g.notes) {
			let key = Math.round(n.beats * 1e6)
			if (!byDur.has(key)) byDur.set(key, [])
			byDur.get(key).push(n)
		}
		let classes = [...byDur.values()].sort((a, b) => b.length - a.length || b[0].beats - a[0].beats)
		let primary = classes[0].sort((a, b) => a.midi - b.midi)
		v1.push({ beat: g.beat, beats: primary[0].beats, notes: primary, tuplet: primary[0].tuplet })
		if (classes.length > 1) {
			let rest = classes.slice(1).flat().sort((a, b) => a.midi - b.midi)
			v2.push({ beat: g.beat, beats: classes[1][0].beats, notes: rest, tuplet: classes[1][0].tuplet })
		}
	}
	return { v1, v2 }
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
 */
export default function toMeasures (notes, { beatsPerMeasure, pickup = false }) {
	let maxBeat = notes.reduce((m, n) => Math.max(m, n.beat + n.beats), 0)
	let edges = measureEdges(maxBeat, beatsPerMeasure, pickup)
	let { v1, v2 } = splitVoices(notes)
	let mv1 = layoutVoice(v1, edges)
	let mv2 = v2.length ? layoutVoice(v2, edges) : null
	let measures = mv1.map((events, i) => ({ voices: mv2 ? [events, mv2[i]] : [events] }))
	return { measures, edges }
}
