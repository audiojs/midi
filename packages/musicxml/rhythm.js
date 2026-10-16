// Duration (in beats, 1 beat = 1 quarter note) → MusicXML note-type vocabulary: the
// tied run of expressible values with the fewest notes that sums *exactly* to the duration
// (see e.g. Ross, "The Art of Music Engraving", ch. 4 on rhythmic notation). Exactness is
// what keeps every measure's durations summing to the time signature: a greedy
// largest-first pick strands remainders (11/8 beat → 4/3 + 1/24).

const U = 48 // table unit, 1/48 beat: the common denominator of every value below
const T3 = { actual: 3, normal: 2 } // triplet: 3 in the time of 2, a 3:2 note lasts 2/3 of its type

// expressible single-note values in units, MusicXML <type>, dot count, tuplet ratio. The 32nd
// and 64th triplets and the 64th fill the gaps a binary grid leaves against a triplet grid
// (a 1/16-grid onset next to a 1/6-grid one is 1/12 beat away).
const TABLE = [
	{ units: 192, type: 'whole', dots: 0 },
	{ units: 144, type: 'half', dots: 1 },
	{ units: 96, type: 'half', dots: 0 },
	{ units: 72, type: 'quarter', dots: 1 },
	{ units: 64, type: 'half', dots: 0, tuplet: T3 },
	{ units: 48, type: 'quarter', dots: 0 },
	{ units: 36, type: 'eighth', dots: 1 },
	{ units: 32, type: 'quarter', dots: 0, tuplet: T3 },
	{ units: 24, type: 'eighth', dots: 0 },
	{ units: 18, type: '16th', dots: 1 },
	{ units: 16, type: 'eighth', dots: 0, tuplet: T3 },
	{ units: 12, type: '16th', dots: 0 },
	{ units: 9, type: '32nd', dots: 1 },
	{ units: 8, type: '16th', dots: 0, tuplet: T3 },
	{ units: 6, type: '32nd', dots: 0 },
	{ units: 4, type: '32nd', dots: 0, tuplet: T3 },
	{ units: 3, type: '64th', dots: 0 },
	{ units: 2, type: '64th', dots: 0, tuplet: T3 },
]

// cost[n] = [notes, tuplet notes] of the best run for n units, pick[n] its last value; grown on
// demand. Every n ≥ 2 has a run (sums of 2 and 3 units).
const cost = [[0, 0], null], pick = [null, null]
function run (n) {
	for (let i = cost.length; i <= n; i++) {
		cost[i] = null
		for (let e of TABLE) {
			let c = e.units <= i && cost[i - e.units]
			if (!c) continue
			let k = [c[0] + 1, c[1] + (e.tuplet ? 1 : 0)]
			if (!cost[i] || k[0] < cost[i][0] || (k[0] === cost[i][0] && k[1] < cost[i][1])) { cost[i] = k; pick[i] = e }
		}
	}
	let out = []
	for (let i = n; i > 0; i -= pick[i].units) out.push(pick[i])
	return out.sort((a, b) => b.units - a.units)
}

/**
 * Decompose a duration into a tied run of expressible note values, longest first, summing
 * exactly to `beats`. A duration off the 1/48-beat lattice (unquantized input) keeps its exact
 * length: the last value absorbs the sub-unit remainder.
 * @param {number} beats — total duration, > 0
 * @returns {Array<{beats, type, dots, tuplet: {actual,normal}|null}>}
 */
export function decompose (beats) {
	let out = run(Math.max(2, Math.round(beats * U))).map(e => ({ beats: e.units / U, type: e.type, dots: e.dots, tuplet: e.tuplet ?? null }))
	out[out.length - 1].beats += beats - out.reduce((s, x) => s + x.beats, 0)
	return out
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
