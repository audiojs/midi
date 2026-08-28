// Duration (in beats, 1 beat = 1 quarter note) → MusicXML note-type vocabulary.
// Greedy largest-first decomposition into a tied run of expressible values — the
// textbook algorithm for rendering an arbitrary rational duration as standard notation
// (see e.g. Ross, "The Art of Music Engraving", ch. 4 on rhythmic notation).

const EPS = 1e-6

// descending table of expressible single-note values: beats, MusicXML <type>, dot count,
// and an optional tuplet ratio {actual, normal} for triplet-grid values.
const TABLE = [
	{ beats: 4, type: 'whole', dots: 0 },
	{ beats: 3, type: 'half', dots: 1 },
	{ beats: 2, type: 'half', dots: 0 },
	{ beats: 4 / 3, type: 'quarter', dots: 0, tuplet: { actual: 3, normal: 2 } }, // quarter-note triplet
	{ beats: 1.5, type: 'quarter', dots: 1 },
	{ beats: 1, type: 'quarter', dots: 0 },
	{ beats: 2 / 3, type: 'eighth', dots: 0, tuplet: { actual: 3, normal: 2 } }, // eighth-note triplet pair — kept for completeness
	{ beats: 0.75, type: 'eighth', dots: 1 },
	{ beats: 0.5, type: 'eighth', dots: 0 },
	{ beats: 1 / 3, type: 'eighth', dots: 0, tuplet: { actual: 3, normal: 2 } }, // single eighth-note triplet
	{ beats: 0.375, type: '16th', dots: 1 },
	{ beats: 0.25, type: '16th', dots: 0 },
	{ beats: 1 / 6, type: '16th', dots: 0, tuplet: { actual: 3, normal: 2 } }, // single 16th-note triplet
	{ beats: 0.1875, type: '32nd', dots: 1 },
	{ beats: 0.125, type: '32nd', dots: 0 },
].sort((a, b) => b.beats - a.beats)

/**
 * Decompose a duration into a tied run of expressible note values, greedy from the largest.
 * @param {number} beats — total duration, > 0
 * @returns {Array<{beats, type, dots, tuplet: {actual,normal}|null}>}
 */
export function decompose (beats) {
	let out = []
	let remaining = beats
	let guard = 0
	while (remaining > EPS && guard++ < 64) {
		let entry = TABLE.find(e => e.beats <= remaining + EPS)
		if (!entry) entry = TABLE[TABLE.length - 1] // smaller than the smallest grid unit — take it anyway
		out.push({ beats: entry.beats, type: entry.type, dots: entry.dots, tuplet: entry.tuplet ?? null })
		remaining -= entry.beats
	}
	return out.length ? out : [{ beats, type: '16th', dots: 0, tuplet: null }]
}

/** Smallest denominator ≤ maxDen such that x*d is (nearly) an integer. */
function rationalDenominator (x, maxDen = 96, eps = 1e-6) {
	for (let d = 1; d <= maxDen; d++) {
		let v = x * d
		if (Math.abs(v - Math.round(v)) < eps) return d
	}
	return maxDen
}

function gcd (a, b) { return b === 0 ? a : gcd(b, a % b) }
function lcm (a, b) { return a / gcd(a, b) * b }

/**
 * Pick the smallest `divisions` (ticks per quarter) ≥ base that keeps every beat value
 * in `values` an exact integer number of ticks (LCM of each value's rational denominator).
 * @param {number[]} values — beat values (durations and onsets) that must round exactly
 * @param {number} [base=480]
 */
export function computeDivisions (values, base = 480) {
	let d = base
	for (let v of values) {
		if (v <= 0) continue
		let den = rationalDenominator(v)
		d = Math.round(lcm(d, den))
	}
	return d
}
