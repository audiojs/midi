// MIDI → PCM — General MIDI Level 1 synth render. Every program and percussion key maps to
// a @audio/synth-* generator (gm.js) — no soundfont, no sample assets ("synth-GM," the
// asset-free answer to "render this MIDI file"). Program/CC7 volume/CC10 pan/CC64 sustain/
// pitch-bend are read per-channel from midi-parse's raw track events (already timestamped in
// seconds) and resolved per note; see the README for exactly which are per-note-accurate and
// which are a documented per-channel simplification.

import parseSmf from '@audio/midi-parse'
import poly from '@audio/synth-poly'
import { midiToHz } from '@audio/note'
import { GM, voiceFor } from './gm.js'

export { GM, voiceFor }

// Velocity → amplitude: a power-law curve (v^1.5) rather than linear velocity — MIDI
// velocity is perceptually closer to a loudness knob than a raw gain multiplier; v^1.5 sits
// between linear and the -40dB-at-0.1-to-0dB-at-1 dB-law some GM modules use, matching the
// General MIDI System Level 1 spec's non-normative guidance that velocity maps to amplitude
// "non-linearly." Applied once, before @audio/synth-poly's own (linear) gain stage.
const VELOCITY_GAMMA = 1.5
const velCurve = (v) => Math.pow(Math.max(0, Math.min(1, v)), VELOCITY_GAMMA)

const PEAK_TARGET = Math.pow(10, -1 / 20) // -1 dBFS
const GM_DEFAULT_CHANNEL_VOLUME = 100 / 127 // MMA GM System Level 1: default Controller #7 = 100
const GM_DEFAULT_BEND_RANGE = 2 // semitones — RPN 0,0 default sensitivity per GM1 spec; custom RPN messages are not parsed (documented limitation)

// short, always-audible fallback for a percussion key outside the GM1 map (35-81)
function fallbackDrum (freq, { fs = 44100 } = {}) {
	let n = Math.round(0.08 * fs)
	let out = new Float32Array(n)
	let s = 5
	for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.4 * (s / 0x3fffffff - 1) * Math.exp(-i / n * 8) }
	return out
}

// binary search: last element with .time <= t (events must be sorted ascending by .time)
function lastAtOrBefore (events, t) {
	let lo = 0, hi = events.length - 1, res
	while (lo <= hi) {
		let mid = (lo + hi) >> 1
		if (events[mid].time <= t) { res = events[mid]; lo = mid + 1 } else hi = mid - 1
	}
	return res
}

// sustain pedal (CC64) down/up intervals — [downTime, upTime], upTime = Infinity if never released
function sustainIntervals (cc64) {
	let out = [], down = null
	for (let e of cc64) {
		if (e.value >= 64 && down == null) down = e.time
		else if (e.value < 64 && down != null) { out.push([down, e.time]); down = null }
	}
	if (down != null) out.push([down, Infinity])
	return out
}
// if `t` falls inside a pedal-down interval, return the interval's release time (or
// `heldEnd` when the pedal is never released) — else null (no extension)
function sustainedRelease (t, intervals, heldEnd) {
	for (let [a, b] of intervals) if (t >= a && t <= b) return b === Infinity ? heldEnd : b
	return null
}

/**
 * @param {Uint8Array|ArrayBuffer|object} midi — SMF bytes, or an already-parsed
 *   @audio/midi-parse result
 * @param {object} opts — {
 *   fs=44100, channels=2 (1|2), voices=32 (per program/drum-key polyphony budget),
 *   tail=1.0 (s, silence padded after the render's natural end),
 *   gain=0.5, normalize=true (peak-normalize to -1dBFS if the mix exceeds it, never boost),
 *   programs, drums (Record<number, Voice> — override the GM map),
 *   tempoScale=1, transpose=0 (semitones)
 * }
 * @returns {{ channelData: Float32Array[], sampleRate: number, duration: number, notes: number }}
 */
export default function render (midi, opts = {}) {
	const {
		fs = 44100, channels = 2, voices = 32, tail = 1.0, gain = 0.5, normalize = true,
		programs: programOverrides, drums: drumOverrides, tempoScale = 1, transpose = 0,
		bendRange = GM_DEFAULT_BEND_RANGE,
	} = opts
	if (channels !== 1 && channels !== 2) throw new RangeError(`midi-render: channels must be 1 or 2, got ${channels}`)
	if (!(tempoScale > 0)) throw new RangeError(`midi-render: tempoScale must be > 0, got ${tempoScale}`)

	const parsed = (midi instanceof Uint8Array || midi instanceof ArrayBuffer) ? parseSmf(midi) : midi
	if (!parsed || !Array.isArray(parsed.notes) || !Array.isArray(parsed.tracks)) throw new TypeError('midi-render: expected SMF bytes/ArrayBuffer or a @audio/midi-parse result')

	// group notes and channel-typed track events (program/CC/pitchBend all carry .time already)
	const notesByCh = new Map()
	for (let n of parsed.notes) { let a = notesByCh.get(n.channel); if (!a) notesByCh.set(n.channel, a = []); a.push(n) }
	const evByCh = new Map()
	for (let track of parsed.tracks) for (let e of track) {
		if (e.channel == null) continue
		let a = evByCh.get(e.channel); if (!a) evByCh.set(e.channel, a = []); a.push(e)
	}
	for (let a of evByCh.values()) a.sort((x, y) => x.time - y.time)

	// deterministic per-render memo: rendered notes are a pure function of (instrument slot,
	// freq, duration) — reused verbatim across repeated notes (poly only reads its `data`,
	// never mutates), which is most of the win on a dense multi-hundred-note file. Keyed by
	// the logical slot id (not the voice function's identity), so two program numbers that
	// happen to share an override function still cache independently.
	const cache = new Map()
	function memoized (fn, id) {
		return (freq, o) => {
			let key = id + ':' + freq.toFixed(3) + ':' + Math.round((o.duration || 0) * 50)
			let hit = cache.get(key)
			if (hit) return hit
			let out = fn(freq, o)
			cache.set(key, out)
			return out
		}
	}

	const heldEnd = parsed.duration + tail
	const stereoBufs = [] // { data: mono Float32Array, gL, gR }
	let totalNotes = 0
	let maxLen = 0

	for (let [ch, chNotes] of notesByCh) {
		let events = evByCh.get(ch) || []
		let programEvs = events.filter(e => e.type === 'program')
		let cc7 = events.filter(e => e.type === 'controller' && e.controller === 7)
		let cc10 = events.filter(e => e.type === 'controller' && e.controller === 10)
		let cc64 = events.filter(e => e.type === 'controller' && e.controller === 64)
		let bends = events.filter(e => e.type === 'pitchBend')
		let sustainIv = cc64.length ? sustainIntervals(cc64) : null

		let isDrum = ch === 9 // MIDI channel 10 (0-indexed 9) — GM percussion

		// CC10 pan is read once per channel, at the value in effect at the channel's first
		// note — mid-channel pan automation is not applied per note (see README limitations).
		let panEv = cc10.length ? lastAtOrBefore(cc10, chNotes[0].time) : null
		let pan = (panEv ? panEv.value : 64) / 127
		let angle = pan * Math.PI / 2
		let gL = Math.cos(angle), gR = Math.sin(angle)

		// build the note list for this channel, resolving program/volume/sustain/bend per note,
		// then group by (program | drum key) — each group gets its own poly() voice-steal pool
		let groups = new Map()
		for (let n of chNotes) {
			let prog = isDrum ? -1 : (programEvs.length ? lastAtOrBefore(programEvs, n.time)?.program ?? 0 : 0)
			let volEv = cc7.length ? lastAtOrBefore(cc7, n.time) : null
			let volGain = volEv ? volEv.value / 127 : GM_DEFAULT_CHANNEL_VOLUME
			let bendEv = bends.length ? lastAtOrBefore(bends, n.time) : null
			let bendSemi = (bendEv ? bendEv.value : 0) * bendRange

			let noteOff = n.time + n.duration
			let release = sustainIv ? sustainedRelease(noteOff, sustainIv, heldEnd) : null
			let duration = release != null ? Math.max(n.duration, release - n.time) : n.duration

			let midiNum = isDrum ? n.midi : n.midi + transpose + bendSemi
			let freq = midiToHz(midiNum)

			let voiceFn = isDrum
				? (drumOverrides?.[n.midi] ?? GM.percussion[n.midi]?.voice ?? fallbackDrum)
				: (programOverrides?.[prog] ?? voiceFor(prog))
			let id = isDrum ? 'd' + n.midi : 'p' + prog

			let group = groups.get(id)
			if (!group) groups.set(id, group = { voice: memoized(voiceFn, id), notes: [] })
			group.notes.push({ time: n.time / tempoScale, freq, duration: duration / tempoScale, velocity: velCurve(n.velocity) * volGain })
			totalNotes++
		}

		let chMono = new Float32Array(0)
		for (let { voice, notes } of groups.values()) {
			let mono = poly(notes, { voice, voices, fs })
			if (mono.length > chMono.length) { let grown = new Float32Array(mono.length); grown.set(chMono); chMono = grown }
			for (let i = 0; i < mono.length; i++) chMono[i] += mono[i]
		}
		if (!chMono.length) continue

		stereoBufs.push({ data: chMono, gL, gR })
		if (chMono.length > maxLen) maxLen = chMono.length
	}

	let total = maxLen + Math.round(tail * fs)
	let L = new Float32Array(total)
	let R = channels === 2 ? new Float32Array(total) : null

	for (let { data, gL, gR } of stereoBufs) {
		if (channels === 1) for (let i = 0; i < data.length; i++) L[i] += data[i]
		else for (let i = 0; i < data.length; i++) { L[i] += data[i] * gL; R[i] += data[i] * gR }
	}

	let chans = channels === 2 ? [L, R] : [L]
	for (let c of chans) for (let i = 0; i < c.length; i++) c[i] *= gain
	if (normalize) {
		let peak = 0
		for (let c of chans) for (let i = 0; i < c.length; i++) { let a = Math.abs(c[i]); if (a > peak) peak = a }
		if (peak > PEAK_TARGET) { let s = PEAK_TARGET / peak; for (let c of chans) for (let i = 0; i < c.length; i++) c[i] *= s }
	}

	return { channelData: chans, sampleRate: fs, duration: total / fs, notes: totalNotes }
}
