// Seconds → beat-grid quantization. A "beat" is always a quarter note (matches bpm's usual
// meaning of quarter-notes-per-minute, independent of the time signature denominator).
// Onsets snap to the nearest grid point; each note independently tries the binary grid
// (1/4, 1/8, 1/16, 1/32 depending on `grid`) and, when `triplets` is on, the 1/8-triplet
// (3 steps/beat) and 1/16-triplet (6 steps/beat) grids too, keeping whichever fits the
// note's raw onset+end best (Dixon-style nearest-neighbour snapping, no group inference).

/**
 * @param {Array<{time, duration, midi, velocity?, channel?, voice?}>} notes — seconds
 * @param {object} [opts]
 * @param {number} [opts.bpm=120]
 * @param {Array<{time, bpm}>} [opts.tempos] — piecewise tempo map (seconds → bpm), overrides bpm
 * @param {number} [opts.grid=16] — binary grid denominator: 4, 8, 16, 32, or 0 = no quantization
 * @param {boolean} [opts.triplets=true] — also try 1/8T (3 steps/beat) and 1/16T (6 steps/beat)
 * @param {number} [opts.minDuration] — shortest kept duration, in beats; default = one grid step
 * @returns {Array<{beat, beats, midi, velocity, channel, voice, tuplet}>} sorted by beat
 */
export default function quantize (notes, opts = {}) {
	let { bpm = 120, tempos, grid = 16, triplets = true, minDuration } = opts
	let toBeat = timeToBeat(bpm, tempos)
	let stepsBin = grid ? grid / 4 : 0
	let minBeats = minDuration ?? (stepsBin ? 1 / stepsBin : 1 / 4)
	let resolutions = grid ? [stepsBin, ...(triplets ? [3, 6] : [])] : [0]

	let out = []
	for (let n of notes) {
		let b0 = toBeat(n.time)
		let b1 = toBeat(n.time + Math.max(0, n.duration ?? 0))
		let best = null
		for (let steps of resolutions) {
			let s0 = steps ? Math.round(b0 * steps) / steps : b0
			let s1 = steps ? Math.round(b1 * steps) / steps : b1
			let err = Math.abs(b0 - s0) + Math.abs(b1 - s1)
			if (!best || err < best.err) best = { s0, s1, err, steps }
		}
		let beat = best.s0
		let beats = Math.max(0, best.s1 - best.s0)
		if (beats > 0 && beats < minBeats) beats = minBeats
		if (beats <= 0) continue // dropped: collapsed to zero length under the grid
		let tuplet = best.steps === 3 ? { actual: 3, normal: 2, unit: 'eighth' }
			: best.steps === 6 ? { actual: 3, normal: 2, unit: '16th' }
			: null
		out.push({
			beat, beats,
			midi: n.midi,
			velocity: n.velocity ?? 0.8,
			channel: n.channel ?? 0,
			voice: n.voice,
			type: n.type,
			tuplet,
		})
	}

	// overlapping notes are kept whole: they are polyphony, and the writers give them separate voices
	out.sort((a, b) => a.beat - b.beat || a.midi - b.midi)
	return out
}

/** Piecewise tempo map → seconds-to-beats function (integrates bpm/60 over each segment). */
export function timeToBeat (bpm = 120, tempos) {
	let segs = tempos && tempos.length ? [...tempos].sort((a, b) => a.time - b.time) : [{ time: 0, bpm }]
	if (segs[0].time > 0) segs = [{ time: 0, bpm: segs[0].bpm }, ...segs]
	let beatAcc = [0]
	for (let i = 1; i < segs.length; i++) {
		let dt = segs[i].time - segs[i - 1].time
		beatAcc.push(beatAcc[i - 1] + dt * segs[i - 1].bpm / 60)
	}
	return (t) => {
		let i = 0
		while (i + 1 < segs.length && segs[i + 1].time <= t) i++
		return beatAcc[i] + (t - segs[i].time) * segs[i].bpm / 60
	}
}
