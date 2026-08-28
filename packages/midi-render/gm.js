// General MIDI Level 1 program/percussion map — synth-GM: every one of the 128 melodic
// programs and every percussion key renders through @audio/synth-* generators, no
// soundfont or sample asset. Program numbers, names and the percussion key map follow the
// MIDI Manufacturers Association "General MIDI System Level 1" specification (MMA/AMEI,
// RP-003/RP-006, 1991), reproduced at https://www.midi.org/specifications/midi1-specifications/general-midi-specifications/general-midi-1-sound-set.
//
// Synthesis citations: FM (Chowning 1973, JAES 21(7)) for epiano/brass/reed; Karplus-Strong
// (Karplus & Strong 1983, Computer Music Journal 7(2)) for plucked strings; modal synthesis
// mode tables (Fletcher & Rossing, The Physics of Musical Instruments, 2nd ed., 1998) for
// bars/plates/membranes/tubes — see @audio/synth-modal for the per-model citations.

import fm, { bell, epiano } from '@audio/synth-fm'
import pluck from '@audio/synth-pluck'
import modal from '@audio/synth-modal'
import { membrane, metal, noiseDrum } from '@audio/synth-drum'
import osc from '@audio/synth-osc'
import adsr from '@audio/synth-envelope'
import { pink, white, brown } from '@audio/synth-noise'
import { hzToMidi } from '@audio/note'

// ---------------------------------------------------------------------------------------
// small DSP helpers — post-processing and envelope shaping shared across families
// ---------------------------------------------------------------------------------------

// sum weighted signals of possibly different lengths: mix([[sig, gain], ...])
function mix (pairs) {
	let n = 0
	for (let [a] of pairs) if (a.length > n) n = a.length
	let out = new Float32Array(n)
	for (let [a, g] of pairs) for (let i = 0; i < a.length; i++) out[i] += a[i] * g
	return out
}

// tanh soft-clip drive, unity-gain normalized at the operating point (amount = drive intensity)
function driveFx (d, amount) {
	let k = Math.tanh(amount) || 1
	let out = new Float32Array(d.length)
	for (let i = 0; i < d.length; i++) out[i] = Math.tanh(d[i] * amount) / k
	return out
}

// one-pole lowpass, RC-style
function lowpassFx (d, cutoff, fs) {
	let a = Math.exp(-2 * Math.PI * cutoff / fs), y = 0
	let out = new Float32Array(d.length)
	for (let i = 0; i < d.length; i++) out[i] = y = d[i] * (1 - a) + y * a
	return out
}

// amplitude tremolo — sine LFO around unity
function tremoloFx (d, { rate = 5, depth = 0.3, fs = 44100 } = {}) {
	let out = new Float32Array(d.length)
	for (let i = 0; i < d.length; i++) out[i] = d[i] * (1 - depth + depth * Math.sin(2 * Math.PI * rate * i / fs))
	return out
}

function reverseFx (d) {
	let out = new Float32Array(d.length)
	for (let i = 0; i < d.length; i++) out[i] = d[d.length - 1 - i]
	return out
}

// Wrap a raw source generator — source(totalSeconds) => Float32Array of exactly that length,
// amp ~1 — with an ADSR gain contour (@audio/synth-envelope). `duration` is the note-on
// length (release starts there), matching the ecosystem's envelope/voice convention.
function sustained (source, { duration = 1, fs = 44100, attack = 0.01, decay = 0.05, sustain = 0.85, release = 0.15, amp = 1 } = {}) {
	let env = adsr({ attack, decay, sustain, release, duration, fs })
	let src = source(env.length / fs)
	let out = new Float32Array(env.length)
	for (let i = 0; i < env.length; i++) out[i] = amp * (src[i] || 0) * env[i]
	return out
}

// raw sine with frequency vibrato — a source() for `sustained()` (flute/pipe/organ family;
// none of the oscillator atoms take a modulated frequency, so this is a small local loop
// in the same style as synth-fm/synth-modal's own raw sample loops)
function vibratoSource (freq, { rate = 5, depth = 0.004 } = {}) {
	return (totalSec, fs = 44100) => {
		let n = Math.round(totalSec * fs)
		let out = new Float32Array(n), phase = 0
		for (let i = 0; i < n; i++) {
			let f = freq * (1 + depth * Math.sin(2 * Math.PI * rate * i / fs))
			phase += 2 * Math.PI * f / fs
			out[i] = Math.sin(phase)
		}
		return out
	}
}

// additive drawbar organ — 9 sine partials at Hammond footages 16'/8'/5⅓'/4'/2⅔'/2'/1⅗'/1⅓'/1'
// (ratios 1/2/3/4/6/8/10/12/16 of the fundamental), summed per `weights`, with slow vibrato.
const DRAWBAR_RATIOS = [1, 2, 3, 4, 6, 8, 10, 12, 16]
function drawbarSource (freq, { weights, vibratoRate = 5.5, vibratoDepth = 0.0015 }) {
	let wsum = weights.reduce((a, b) => a + Math.abs(b), 0) || 1
	return (totalSec, fs = 44100) => {
		let n = Math.round(totalSec * fs)
		let out = new Float32Array(n)
		let phase = new Float64Array(DRAWBAR_RATIOS.length)
		for (let i = 0; i < n; i++) {
			let vib = 1 + vibratoDepth * Math.sin(2 * Math.PI * vibratoRate * i / fs)
			let s = 0
			for (let k = 0; k < DRAWBAR_RATIOS.length; k++) {
				phase[k] += 2 * Math.PI * freq * DRAWBAR_RATIOS[k] * vib / fs
				s += weights[k] * Math.sin(phase[k])
			}
			out[i] = s / wsum
		}
		return out
	}
}

// `sustained()`'s source(totalSec) contract only passes seconds — fs is captured by closure
// via a thin adapter so drawbarSource/vibratoSource can still see it.
function withFs (srcFactory, fs) { return (totalSec) => srcFactory(totalSec, fs) }

// ---------------------------------------------------------------------------------------
// pitched family factories — each returns a Voice: (freq, {fs, duration, ...}) => Float32Array
// ---------------------------------------------------------------------------------------

// Piano (0-3): 2-op FM hammer transient + a modal string layer for body/sustain.
// t60 scales with pitch — bass strings ring longer than treble (longer, thicker strings;
// Fletcher & Rossing ch. 12 "Piano," decay-vs-register). Anchored 8s @ MIDI 36, 1.5s @ MIDI 96
// (linear interpolation between the two measured anchor points — a simplification; real
// piano decay is not linear in MIDI number, but this is close enough to be musical).
function acousticPiano ({ index = 3, hammerAmp = 0.45, bodyAmp = 0.7, inharmonicity = 0.0002 } = {}) {
	return (freq, { fs = 44100 } = {}) => {
		let midi = hzToMidi(freq)
		let k = Math.max(0, Math.min(1, (midi - 36) / (96 - 36)))
		let t60 = 8 + (1.5 - 8) * k
		let hammer = fm(freq, { ratio: 1, index, indexDecay: 0.06, indexFloor: 0.05, duration: 0.35, fs, amp: hammerAmp, attack: 0.001, release: 0.3 })
		let body = modal(freq, { model: 'string', t60, inharmonicity, nmodes: 6, exciter: 'impulse', fs, amp: bodyAmp })
		return mix([[hammer, 1], [body, 1]])
	}
}

// Guitar/bass/pizzicato/harp family — Karplus-Strong (Karplus & Strong 1983) with optional
// post drive/lowpass/percussive click.
function pluckedString ({ damp = 0.996, duration = 2, amp = 0.6, lp = null, driveAmt = 0, click = 0 } = {}) {
	return (freq, { fs = 44100 } = {}) => {
		let d = pluck(freq, { damp, duration, fs, amp })
		if (lp) d = lowpassFx(d, lp, fs)
		if (driveAmt) d = driveFx(d, driveAmt)
		if (click) {
			let c = noiseDrum({ duration: Math.min(0.03, duration), fs, amp: click })
			for (let i = 0; i < Math.min(c.length, d.length); i++) d[i] += c[i]
		}
		return d
	}
}

// Chromatic-percussion mallets — modal bar/plate resonator bank (Fletcher & Rossing ch. 3,
// see @audio/synth-modal), optional tremolo (vibraphone) or freeform reverse (FX).
function barVoice ({ model = 'bar', t60 = 1.5, nmodes = 6, strike = 0.5, amp = 0.7, tremolo = null } = {}) {
	return (freq, { fs = 44100 } = {}) => {
		let d = modal(freq, { model, t60, nmodes, strike, fs, amp })
		return tremolo ? tremoloFx(d, { ...tremolo, fs }) : d
	}
}

// Organ family — additive drawbar tonewheel model + optional percussive click / drive.
function organVoice ({ weights, vibratoRate = 5.5, vibratoDepth = 0.0015, attack = 0.02, release = 0.12, click = 0, driveAmt = 0, amp = 0.55 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) => {
		let src = withFs(drawbarSource(freq, { weights, vibratoRate, vibratoDepth }), fs)
		let out = sustained(src, { duration, fs, attack, decay: 0.001, sustain: 1, release, amp })
		if (click) {
			let hit = metal(freq * 4, { duration: Math.min(0.05, click), fs, amp: 0.25 })
			for (let i = 0; i < Math.min(hit.length, out.length); i++) out[i] += hit[i]
		}
		return driveAmt ? driveFx(out, driveAmt) : out
	}
}

// Accordion/harmonica — sawtooth body + a reed-like FM edge, sustained envelope (free reeds
// speak continuously while air flows — sustain=1 while the key/note is held).
function reedBox ({ ratio = 3, index = 1.3, tremolo = null, amp = 0.55 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) => {
		let src = (t) => mix([
			[osc(freq, { duration: t, fs, type: 'sawtooth', amp: 1 }), 0.55],
			[fm(freq, { ratio, index, indexDecay: 0, duration: t, fs, amp: 1, attack: 0.01, release: 0.01 }), 0.45],
		])
		let out = sustained(src, { duration, fs, attack: 0.05, decay: 0.02, sustain: 1, release: 0.1, amp })
		return tremolo ? tremoloFx(out, { ...tremolo, fs }) : out
	}
}

// Strings/pads — detuned oscillator pair(s) through a slow ADSR (bowed-string ensemble
// beating; the ±cents detune between unison voices is what reads as "strings" rather than
// a single dry oscillator).
function detunedPad ({ type = 'sawtooth', detuneCents = 6, voicesN = 2, attack = 0.15, decay = 0.1, sustain = 0.9, release = 0.4, amp = 0.5, tremolo = null } = {}) {
	let offsets = voicesN === 3 ? [-detuneCents, 0, detuneCents] : voicesN === 1 ? [0] : [-detuneCents, detuneCents]
	return (freq, { fs = 44100, duration = 1 } = {}) => {
		let src = (t) => mix(offsets.map(off => [osc(freq, { duration: t, fs, type, amp: 1, detune: off }), 1 / offsets.length]))
		let out = sustained(src, { duration, fs, attack, decay, sustain, release, amp })
		return tremolo ? tremoloFx(out, { ...tremolo, fs }) : out
	}
}

// Brass — Chowning's classic patch: modulation index *rises* through the attack rather than
// decaying (brightness grows with loudness, the "blaring" onset). `fm`'s exponential decay
// toward indexFloor runs equally well upward (v0 < indexFloor) as downward, so a low `index`
// climbing to a high `indexFloor` over `indexDecay` seconds gives the rising-index attack —
// see Chowning 1973 §"brass instrument tones."
function brassVoice ({ ratio = 1, indexPeak = 6, rise = 0.08, amp = 0.55 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) =>
		fm(freq, { ratio, index: 0.4, indexFloor: indexPeak, indexDecay: rise, duration: duration + 0.15, fs, amp, attack: 0.008, release: 0.15 })
}

// Reed/pipe FM — 2-op ratio-2 modulation approximates the odd-harmonic-leaning spectrum of
// single/double-reed and air-column tones (Chowning 1973's clarinet-like example uses c:m=1:2).
function reedFm ({ ratio = 2, index = 2, indexFloor = 1, rise = 0.05, amp = 0.5 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) =>
		fm(freq, { ratio, index, indexFloor, indexDecay: rise, duration: duration + 0.15, fs, amp, attack: 0.02, release: 0.15 })
}

// Clarinet — a real cylindrical, closed-at-the-reed bore suppresses even harmonics, which is
// exactly a square wave's spectrum (odd harmonics, 1/k roll-off) — Fletcher & Rossing ch. 10.
function clarinetVoice ({ amp = 0.5 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) =>
		sustained((t) => osc(freq, { duration: t, fs, type: 'square', amp: 1 }), { duration, fs, attack: 0.04, decay: 0.05, sustain: 0.85, release: 0.12, amp })
}

// Flute/pipe family — sine + breath noise (airflow turbulence) + vibrato. Breath is pink
// noise (closer to a real air-jet's spectral tilt than white) mixed `breathDb` below the tone.
function breathTone ({ rate = 5, depth = 0.004, breathDb = -25, attack = 0.05, release = 0.1, amp = 0.55, seed = 7 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) => {
		let tone = sustained(withFs(vibratoSource(freq, { rate, depth }), fs), { duration, fs, attack, decay: 0.01, sustain: 1, release, amp })
		let breathAmp = amp * Math.pow(10, breathDb / 20)
		let breath = sustained((t) => pink(t, { seed, fs }), { duration, fs, attack: attack * 1.5, decay: 0.01, sustain: 1, release, amp: breathAmp })
		return mix([[tone, 1], [breath, 1]])
	}
}

// Synth lead/pad — plain oscillator through ADSR; brief "keep sane" families (80-103).
function synthOsc ({ type = 'sawtooth', attack = 0.01, decay = 0.05, sustain = 0.8, release = 0.1, amp = 0.5, driveAmt = 0, sub = 0 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) => {
		let src = (t) => sub
			? mix([[osc(freq, { duration: t, fs, type, amp: 1 }), 1 - sub], [osc(freq / 2, { duration: t, fs, type, amp: 1 }), sub]])
			: osc(freq, { duration: t, fs, type, amp: 1 })
		let out = sustained(src, { duration, fs, attack, decay, sustain, release, amp })
		return driveAmt ? driveFx(out, driveAmt) : out
	}
}

// FX (96-103) — bell/noise textures, deliberately loose ("keep sane" per brief: audible and
// stable, not a faithful synth-effects patch).
function fxBell ({ index = 8, indexDecay = 1.5, duration = 2, amp = 0.5, noiseMix = 0 } = {}) {
	return (freq, { fs = 44100 } = {}) => {
		let b = bell(freq, { duration, index, indexDecay, fs, amp })
		return noiseMix ? mix([[b, 1], [pink(duration, { seed: 11, fs }), noiseMix]]) : b
	}
}
function fxNoise ({ color = 'pink', duration = 1.5, attack = 0.3, release = 0.6, amp = 0.5, seed = 13, tremolo: trem = null } = {}) {
	return (freq, { fs = 44100 } = {}) => {
		let src = color === 'brown' ? brown(duration, { seed, fs }) : color === 'white' ? white(duration, { seed, fs }) : pink(duration, { seed, fs })
		let out = sustained(() => src, { duration: duration - release, fs, attack, decay: 0.01, sustain: 1, release, amp })
		return trem ? tremoloFx(out, { ...trem, fs }) : out
	}
}

// Ethnic drone (bagpipe) — sustained reed-ish sawtooth, no attack shaping (bagpipes speak
// continuously while the bag is under pressure).
function droneVoice ({ amp = 0.5 } = {}) {
	return (freq, { fs = 44100, duration = 1 } = {}) =>
		sustained((t) => mix([[osc(freq, { duration: t, fs, type: 'sawtooth', amp: 1 }), 0.7], [fm(freq, { ratio: 2, index: 1, duration: t, fs, amp: 1, attack: 0.01, release: 0.01 }), 0.3]]),
			{ duration, fs, attack: 0.08, decay: 0.02, sustain: 1, release: 0.15, amp })
}

// One-shot sound-effect noise burst (120-127 family) — freq-agnostic, colored-noise transient.
function sfxBurst ({ color = 'white', duration = 0.4, attack = 0.002, release = 0.25, amp = 0.6, seed = 3, tremolo: trem = null, metallic = false } = {}) {
	return (freq, { fs = 44100 } = {}) => {
		let src = color === 'brown' ? brown(duration, { seed, fs }) : color === 'pink' ? pink(duration, { seed, fs }) : white(duration, { seed, fs })
		let out = sustained(() => src, { duration: Math.max(0.01, duration - release), fs, attack, decay: 0.005, sustain: 1, release, amp })
		if (metallic) out = mix([[out, 1], [metal(freq || 400, { duration, fs, amp: amp * 0.5 }), 1]])
		return trem ? tremoloFx(out, { ...trem, fs }) : out
	}
}

// ---------------------------------------------------------------------------------------
// GM.programs — 128 entries, program numbers/names per MMA General MIDI 1 Sound Set
// ---------------------------------------------------------------------------------------

const programs = [
	// Piano (0-7)
	{ name: 'Acoustic Grand Piano', family: 'Piano', voice: acousticPiano({ index: 3 }) },
	{ name: 'Bright Acoustic Piano', family: 'Piano', voice: acousticPiano({ index: 4.5, hammerAmp: 0.55 }) },
	{ name: 'Electric Grand Piano', family: 'Piano', voice: acousticPiano({ index: 4, bodyAmp: 0.5, hammerAmp: 0.6 }) },
	{ name: 'Honky-tonk Piano', family: 'Piano', voice: (freq, o) => mix([[acousticPiano({ index: 3.5 })(freq * Math.pow(2, 6 / 1200), o), 0.5], [acousticPiano({ index: 3.5 })(freq * Math.pow(2, -6 / 1200), o), 0.5]]) },
	{ name: 'Electric Piano 1', family: 'Piano', voice: (freq, { fs = 44100, duration = 1 } = {}) => epiano(freq, { duration: Math.max(1.5, duration + 0.5), fs, amp: 0.6 }) },
	{ name: 'Electric Piano 2', family: 'Piano', voice: (freq, { fs = 44100, duration = 1 } = {}) => epiano(freq, { duration: Math.max(1.5, duration + 0.5), fs, ratio: 2, index: 4, amp: 0.55 }) },
	{ name: 'Harpsichord', family: 'Piano', voice: pluckedString({ damp: 0.998, duration: 1.5, amp: 0.55 }) },
	{ name: 'Clavinet', family: 'Piano', voice: pluckedString({ damp: 0.95, duration: 0.6, amp: 0.6 }) },

	// Chromatic Percussion (8-15)
	{ name: 'Celesta', family: 'Chromatic Percussion', voice: (freq, { fs = 44100 } = {}) => bell(freq, { duration: 2, index: 5, indexDecay: 1, fs, amp: 0.5 }) },
	{ name: 'Glockenspiel', family: 'Chromatic Percussion', voice: barVoice({ t60: 3.5, nmodes: 8, amp: 0.65 }) },
	{ name: 'Music Box', family: 'Chromatic Percussion', voice: barVoice({ t60: 1.2, nmodes: 5, amp: 0.5 }) },
	{ name: 'Vibraphone', family: 'Chromatic Percussion', voice: barVoice({ t60: 3, nmodes: 6, amp: 0.6, tremolo: { rate: 5, depth: 0.4 } }) },
	{ name: 'Marimba', family: 'Chromatic Percussion', voice: barVoice({ t60: 1.2, nmodes: 6, strike: 0.3, amp: 0.65 }) },
	{ name: 'Xylophone', family: 'Chromatic Percussion', voice: barVoice({ t60: 0.6, nmodes: 8, strike: 0.15, amp: 0.65 }) },
	{ name: 'Tubular Bells', family: 'Chromatic Percussion', voice: (freq, { fs = 44100 } = {}) => bell(freq, { duration: 5, index: 10, indexDecay: 3, fs, amp: 0.55 }) },
	{ name: 'Dulcimer', family: 'Chromatic Percussion', voice: pluckedString({ damp: 0.993, duration: 1.5, amp: 0.6 }) },

	// Organ (16-23)
	{ name: 'Drawbar Organ', family: 'Organ', voice: organVoice({ weights: [0.8, 0.6, 0.3, 0.9, 0.2, 0.5, 0.1, 0.2, 0.15] }) },
	{ name: 'Percussive Organ', family: 'Organ', voice: organVoice({ weights: [0.8, 0.9, 0, 0.6, 0, 0.3, 0, 0, 0], click: 0.04 }) },
	{ name: 'Rock Organ', family: 'Organ', voice: organVoice({ weights: [0.9, 0.7, 0.5, 0.8, 0.3, 0.4, 0.2, 0.2, 0.1], driveAmt: 1.5 }) },
	{ name: 'Church Organ', family: 'Organ', voice: organVoice({ weights: [0.9, 0.6, 0.4, 0.7, 0.3, 0.5, 0.3, 0.3, 0.3], attack: 0.15, release: 0.6, amp: 0.6 }) },
	{ name: 'Reed Organ', family: 'Organ', voice: organVoice({ weights: [0.9, 0.2, 0.5, 0.1, 0, 0, 0, 0, 0], attack: 0.08 }) },
	{ name: 'Accordion', family: 'Organ', voice: reedBox({ ratio: 3, index: 1.3 }) },
	{ name: 'Harmonica', family: 'Organ', voice: reedBox({ ratio: 2, index: 1.8, amp: 0.5 }) },
	{ name: 'Tango Accordion', family: 'Organ', voice: reedBox({ ratio: 3, index: 1.5, tremolo: { rate: 6, depth: 0.15 } }) },

	// Guitar (24-31)
	{ name: 'Acoustic Guitar (nylon)', family: 'Guitar', voice: pluckedString({ damp: 0.994, duration: 2 }) },
	{ name: 'Acoustic Guitar (steel)', family: 'Guitar', voice: pluckedString({ damp: 0.997, duration: 2.5 }) },
	{ name: 'Electric Guitar (jazz)', family: 'Guitar', voice: pluckedString({ damp: 0.99, duration: 1.8, lp: 2500 }) },
	{ name: 'Electric Guitar (clean)', family: 'Guitar', voice: pluckedString({ damp: 0.998, duration: 2.5 }) },
	{ name: 'Electric Guitar (muted)', family: 'Guitar', voice: pluckedString({ damp: 0.985, duration: 0.6 }) },
	{ name: 'Overdriven Guitar', family: 'Guitar', voice: pluckedString({ damp: 0.996, duration: 2, driveAmt: 3 }) },
	{ name: 'Distortion Guitar', family: 'Guitar', voice: pluckedString({ damp: 0.996, duration: 2, driveAmt: 8 }) },
	{ name: 'Guitar harmonics', family: 'Guitar', voice: (freq, o) => pluckedString({ damp: 0.99, duration: 1.2, amp: 0.5 })(freq * 2, o) },

	// Bass (32-39)
	{ name: 'Acoustic Bass', family: 'Bass', voice: pluckedString({ damp: 0.999, duration: 2, amp: 0.75 }) },
	{ name: 'Electric Bass (finger)', family: 'Bass', voice: pluckedString({ damp: 0.9985, duration: 2, amp: 0.75 }) },
	{ name: 'Electric Bass (pick)', family: 'Bass', voice: pluckedString({ damp: 0.998, duration: 1.8, amp: 0.75, click: 0.15 }) },
	{ name: 'Fretless Bass', family: 'Bass', voice: pluckedString({ damp: 0.999, duration: 2.2, amp: 0.7 }) },
	{ name: 'Slap Bass 1', family: 'Bass', voice: pluckedString({ damp: 0.995, duration: 1.2, amp: 0.75, click: 0.3 }) },
	{ name: 'Slap Bass 2', family: 'Bass', voice: pluckedString({ damp: 0.993, duration: 1, amp: 0.75, click: 0.35 }) },
	{ name: 'Synth Bass 1', family: 'Bass', voice: synthOsc({ type: 'sawtooth', attack: 0.004, decay: 0.2, sustain: 0.6, release: 0.15, amp: 0.6 }) },
	{ name: 'Synth Bass 2', family: 'Bass', voice: synthOsc({ type: 'square', attack: 0.004, decay: 0.15, sustain: 0.7, release: 0.1, amp: 0.6 }) },

	// Strings (40-47)
	{ name: 'Violin', family: 'Strings', voice: detunedPad({ attack: 0.12, amp: 0.5 }) },
	{ name: 'Viola', family: 'Strings', voice: detunedPad({ attack: 0.14, amp: 0.5 }) },
	{ name: 'Cello', family: 'Strings', voice: detunedPad({ attack: 0.18, amp: 0.55 }) },
	{ name: 'Contrabass', family: 'Strings', voice: detunedPad({ attack: 0.22, amp: 0.55 }) },
	{ name: 'Tremolo Strings', family: 'Strings', voice: detunedPad({ attack: 0.1, amp: 0.5, tremolo: { rate: 8, depth: 0.5 } }) },
	{ name: 'Pizzicato Strings', family: 'Strings', voice: pluckedString({ damp: 0.994, duration: 0.5, amp: 0.55 }) },
	{ name: 'Orchestral Harp', family: 'Strings', voice: pluckedString({ damp: 0.996, duration: 2.5, amp: 0.55 }) },
	{ name: 'Timpani', family: 'Strings', voice: (freq, { fs = 44100 } = {}) => membrane(freq, { drop: 1.4, duration: 1.4, fs, amp: 0.85 }) },

	// Ensemble (48-55)
	{ name: 'String Ensemble 1', family: 'Ensemble', voice: detunedPad({ voicesN: 3, detuneCents: 7, attack: 0.15, amp: 0.55 }) },
	{ name: 'String Ensemble 2', family: 'Ensemble', voice: detunedPad({ voicesN: 3, detuneCents: 5, type: 'triangle', attack: 0.2, amp: 0.55 }) },
	{ name: 'SynthStrings 1', family: 'Ensemble', voice: detunedPad({ voicesN: 2, detuneCents: 8, attack: 0.06, amp: 0.55 }) },
	{ name: 'SynthStrings 2', family: 'Ensemble', voice: detunedPad({ voicesN: 2, detuneCents: 10, type: 'square', attack: 0.08, amp: 0.5 }) },
	{ name: 'Choir Aahs', family: 'Ensemble', voice: detunedPad({ type: 'triangle', voicesN: 3, detuneCents: 8, attack: 0.15, sustain: 0.85, amp: 0.55 }) },
	{ name: 'Voice Oohs', family: 'Ensemble', voice: detunedPad({ type: 'sine', voicesN: 3, detuneCents: 6, attack: 0.18, sustain: 0.85, amp: 0.55 }) },
	{ name: 'Synth Voice', family: 'Ensemble', voice: detunedPad({ type: 'square', voicesN: 2, detuneCents: 5, attack: 0.05, amp: 0.45 }) },
	{ name: 'Orchestra Hit', family: 'Ensemble', voice: detunedPad({ voicesN: 3, detuneCents: 9, attack: 0.004, decay: 0.3, sustain: 0.1, release: 0.2, amp: 0.65 }) },

	// Brass (56-63)
	{ name: 'Trumpet', family: 'Brass', voice: brassVoice({ indexPeak: 7, rise: 0.05, amp: 0.55 }) },
	{ name: 'Trombone', family: 'Brass', voice: brassVoice({ indexPeak: 5.5, rise: 0.08, amp: 0.55 }) },
	{ name: 'Tuba', family: 'Brass', voice: brassVoice({ indexPeak: 4, rise: 0.12, amp: 0.6 }) },
	{ name: 'Muted Trumpet', family: 'Brass', voice: brassVoice({ ratio: 2.4, indexPeak: 5, rise: 0.04, amp: 0.4 }) },
	{ name: 'French Horn', family: 'Brass', voice: brassVoice({ indexPeak: 4.5, rise: 0.1, amp: 0.5 }) },
	{ name: 'Brass Section', family: 'Brass', voice: (freq, o) => mix([[brassVoice({ indexPeak: 6.5, rise: 0.06 })(freq * Math.pow(2, 4 / 1200), o), 0.5], [brassVoice({ indexPeak: 6.5, rise: 0.06 })(freq * Math.pow(2, -4 / 1200), o), 0.5]]) },
	{ name: 'SynthBrass 1', family: 'Brass', voice: brassVoice({ indexPeak: 8, rise: 0.02, amp: 0.6 }) },
	{ name: 'SynthBrass 2', family: 'Brass', voice: brassVoice({ ratio: 2, indexPeak: 7, rise: 0.03, amp: 0.55 }) },

	// Reed (64-71)
	{ name: 'Soprano Sax', family: 'Reed', voice: reedFm({ ratio: 1.5, index: 2.5, indexFloor: 1.5, amp: 0.5 }) },
	{ name: 'Alto Sax', family: 'Reed', voice: reedFm({ ratio: 2, index: 2, indexFloor: 1.2, amp: 0.5 }) },
	{ name: 'Tenor Sax', family: 'Reed', voice: reedFm({ ratio: 2, index: 1.8, indexFloor: 1, amp: 0.55 }) },
	{ name: 'Baritone Sax', family: 'Reed', voice: reedFm({ ratio: 2, index: 1.6, indexFloor: 0.9, amp: 0.55 }) },
	{ name: 'Oboe', family: 'Reed', voice: reedFm({ ratio: 2, index: 3, indexFloor: 2, rise: 0.03, amp: 0.45 }) },
	{ name: 'English Horn', family: 'Reed', voice: reedFm({ ratio: 2, index: 2.2, indexFloor: 1.4, amp: 0.45 }) },
	{ name: 'Bassoon', family: 'Reed', voice: reedFm({ ratio: 2, index: 1.8, indexFloor: 1, amp: 0.5 }) },
	{ name: 'Clarinet', family: 'Reed', voice: clarinetVoice({ amp: 0.5 }) },

	// Pipe (72-79)
	{ name: 'Piccolo', family: 'Pipe', voice: breathTone({ breathDb: -32, depth: 0.003, amp: 0.5 }) },
	{ name: 'Flute', family: 'Pipe', voice: breathTone({ breathDb: -25, depth: 0.005, amp: 0.55 }) },
	{ name: 'Recorder', family: 'Pipe', voice: breathTone({ breathDb: -28, depth: 0.001, rate: 3, amp: 0.5 }) },
	{ name: 'Pan Flute', family: 'Pipe', voice: breathTone({ breathDb: -22, depth: 0.003, amp: 0.5 }) },
	{ name: 'Blown Bottle', family: 'Pipe', voice: breathTone({ breathDb: -18, depth: 0.006, rate: 3.5, amp: 0.5 }) },
	{ name: 'Shakuhachi', family: 'Pipe', voice: breathTone({ breathDb: -16, depth: 0.006, rate: 4, amp: 0.5 }) },
	{ name: 'Whistle', family: 'Pipe', voice: breathTone({ breathDb: -36, depth: 0.002, amp: 0.5 }) },
	{ name: 'Ocarina', family: 'Pipe', voice: breathTone({ breathDb: -30, depth: 0.003, amp: 0.5 }) },

	// Synth Lead (80-87)
	{ name: 'Lead 1 (square)', family: 'Synth Lead', voice: synthOsc({ type: 'square', attack: 0.005, amp: 0.5 }) },
	{ name: 'Lead 2 (sawtooth)', family: 'Synth Lead', voice: synthOsc({ type: 'sawtooth', attack: 0.005, amp: 0.5 }) },
	{ name: 'Lead 3 (calliope)', family: 'Synth Lead', voice: synthOsc({ type: 'triangle', attack: 0.02, amp: 0.55 }) },
	{ name: 'Lead 4 (chiff)', family: 'Synth Lead', voice: (freq, o) => mix([[synthOsc({ type: 'square', attack: 0.01, amp: 0.5 })(freq, o), 1], [sfxBurst({ color: 'white', duration: 0.04, release: 0.03, amp: 0.3 })(freq, o), 1]]) },
	{ name: 'Lead 5 (charang)', family: 'Synth Lead', voice: synthOsc({ type: 'sawtooth', attack: 0.004, amp: 0.55, driveAmt: 1.5 }) },
	{ name: 'Lead 6 (voice)', family: 'Synth Lead', voice: detunedPad({ type: 'triangle', voicesN: 1, attack: 0.03, sustain: 0.8, amp: 0.5 }) },
	{ name: 'Lead 7 (fifths)', family: 'Synth Lead', voice: (freq, { fs = 44100, duration = 1 } = {}) => mix([[osc(freq, { duration: duration + 0.1, fs, type: 'sawtooth', amp: 0.5 }), 1], [osc(freq * 1.5, { duration: duration + 0.1, fs, type: 'sawtooth', amp: 0.4 }), 1]]) },
	{ name: 'Lead 8 (bass + lead)', family: 'Synth Lead', voice: synthOsc({ type: 'sawtooth', attack: 0.005, amp: 0.55, sub: 0.4 }) },

	// Synth Pad (88-95)
	{ name: 'Pad 1 (new age)', family: 'Synth Pad', voice: detunedPad({ type: 'sine', voicesN: 3, detuneCents: 5, attack: 0.5, amp: 0.5 }) },
	{ name: 'Pad 2 (warm)', family: 'Synth Pad', voice: detunedPad({ type: 'triangle', voicesN: 2, attack: 0.4, amp: 0.5 }) },
	{ name: 'Pad 3 (polysynth)', family: 'Synth Pad', voice: detunedPad({ type: 'sawtooth', voicesN: 3, detuneCents: 9, attack: 0.3, amp: 0.5 }) },
	{ name: 'Pad 4 (choir)', family: 'Synth Pad', voice: detunedPad({ type: 'triangle', voicesN: 3, detuneCents: 7, attack: 0.5, sustain: 0.85, amp: 0.5 }) },
	{ name: 'Pad 5 (bowed)', family: 'Synth Pad', voice: detunedPad({ type: 'sawtooth', voicesN: 2, attack: 0.6, amp: 0.5, tremolo: { rate: 3, depth: 0.2 } }) },
	{ name: 'Pad 6 (metallic)', family: 'Synth Pad', voice: (freq, o) => mix([[detunedPad({ type: 'sawtooth', voicesN: 2, attack: 0.3, amp: 0.4 })(freq, o), 1], [barVoice({ t60: 2, nmodes: 5, amp: 0.25 })(freq, o), 1]]) },
	{ name: 'Pad 7 (halo)', family: 'Synth Pad', voice: detunedPad({ type: 'sine', voicesN: 3, detuneCents: 10, attack: 0.7, release: 0.8, amp: 0.5 }) },
	{ name: 'Pad 8 (sweep)', family: 'Synth Pad', voice: (freq, { fs = 44100, duration = 1 } = {}) => sustained((t) => osc(freq, { duration: t, fs, type: 'sawtooth', amp: 1 }), { duration, fs, attack: Math.max(0.5, duration * 0.6), decay: 0.05, sustain: 0.9, release: 0.5, amp: 0.5 }) },

	// Synth Effects (96-103)
	{ name: 'FX 1 (rain)', family: 'Synth Effects', voice: fxNoise({ color: 'pink', duration: 1.8, attack: 0.4, release: 0.7 }) },
	{ name: 'FX 2 (soundtrack)', family: 'Synth Effects', voice: detunedPad({ type: 'sine', voicesN: 3, detuneCents: 12, attack: 0.6, amp: 0.5 }) },
	{ name: 'FX 3 (crystal)', family: 'Synth Effects', voice: fxBell({ index: 6, indexDecay: 0.8, duration: 1.5, amp: 0.5 }) },
	{ name: 'FX 4 (atmosphere)', family: 'Synth Effects', voice: (freq, o) => mix([[detunedPad({ type: 'triangle', voicesN: 2, attack: 0.5, amp: 0.35 })(freq, o), 1], [fxNoise({ color: 'pink', duration: 1.5, attack: 0.5, release: 0.6, amp: 0.2 })(freq, o), 1]]) },
	{ name: 'FX 5 (brightness)', family: 'Synth Effects', voice: fxBell({ index: 10, indexDecay: 0.5, duration: 1.2, amp: 0.55, noiseMix: 0.15 }) },
	{ name: 'FX 6 (goblins)', family: 'Synth Effects', voice: (freq, { fs = 44100 } = {}) => tremoloFx(bell(freq * 0.6, { duration: 1.5, index: 12, indexDecay: 0.6, fs, amp: 0.5 }), { rate: 7, depth: 0.5, fs }) },
	{ name: 'FX 7 (echoes)', family: 'Synth Effects', voice: (freq, { fs = 44100 } = {}) => { let b = bell(freq, { duration: 0.6, index: 8, indexDecay: 0.3, fs, amp: 0.5 }); let taps = [[b, 1]]; let delay = Math.round(0.18 * fs); for (let k = 1; k <= 3; k++) { let g = Math.pow(0.55, k); let d = new Float32Array(b.length + delay * k); for (let i = 0; i < b.length; i++) d[i + delay * k] = b[i] * g; taps.push([d, 1]) } return mix(taps) } },
	{ name: 'FX 8 (sci-fi)', family: 'Synth Effects', voice: (freq, { fs = 44100, duration = 1 } = {}) => tremoloFx(fm(freq, { ratio: 1.5, index: 0.5, indexFloor: 5, indexDecay: duration * 0.5, duration: duration + 0.3, fs, amp: 0.5 }), { rate: 6, depth: 0.3, fs }) },

	// Ethnic (104-111)
	{ name: 'Sitar', family: 'Ethnic', voice: (freq, o) => mix([[pluckedString({ damp: 0.997, duration: 2.5, amp: 0.5 })(freq, o), 1], [pluckedString({ damp: 0.99, duration: 1, amp: 0.15 })(freq * 2, o), 1]]) },
	{ name: 'Banjo', family: 'Ethnic', voice: pluckedString({ damp: 0.99, duration: 1, amp: 0.6 }) },
	{ name: 'Shamisen', family: 'Ethnic', voice: pluckedString({ damp: 0.985, duration: 0.8, amp: 0.6 }) },
	{ name: 'Koto', family: 'Ethnic', voice: pluckedString({ damp: 0.994, duration: 1.6, amp: 0.55 }) },
	{ name: 'Kalimba', family: 'Ethnic', voice: barVoice({ t60: 1.5, nmodes: 5, amp: 0.6 }) },
	{ name: 'Bag pipe', family: 'Ethnic', voice: droneVoice({ amp: 0.55 }) },
	{ name: 'Fiddle', family: 'Ethnic', voice: detunedPad({ attack: 0.05, detuneCents: 8, amp: 0.55 }) },
	{ name: 'Shanai', family: 'Ethnic', voice: reedFm({ ratio: 1.8, index: 3.5, indexFloor: 2.5, rise: 0.02, amp: 0.5 }) },

	// Percussive (112-119)
	{ name: 'Tinkle Bell', family: 'Percussive', voice: (freq, { fs = 44100 } = {}) => bell(freq * 2, { duration: 1, index: 6, indexDecay: 0.4, fs, amp: 0.45 }) },
	{ name: 'Agogo', family: 'Percussive', voice: (freq, { fs = 44100 } = {}) => metal(freq, { duration: 0.4, fs, amp: 0.55 }) },
	{ name: 'Steel Drums', family: 'Percussive', voice: barVoice({ model: 'plate', t60: 1.5, nmodes: 5, amp: 0.6 }) },
	{ name: 'Woodblock', family: 'Percussive', voice: barVoice({ t60: 0.15, nmodes: 3, amp: 0.6 }) },
	{ name: 'Taiko Drum', family: 'Percussive', voice: (freq, { fs = 44100 } = {}) => membrane(Math.min(freq, 90), { drop: 3.5, duration: 0.9, fs, amp: 0.9 }) },
	{ name: 'Melodic Tom', family: 'Percussive', voice: (freq, { fs = 44100 } = {}) => membrane(freq, { drop: 2, duration: 0.4, fs, amp: 0.85 }) },
	{ name: 'Synth Drum', family: 'Percussive', voice: (freq, { fs = 44100 } = {}) => membrane(freq, { drop: 5, duration: 0.35, fs, amp: 0.85 }) },
	{ name: 'Reverse Cymbal', family: 'Percussive', voice: (freq, { fs = 44100 } = {}) => reverseFx(metal(6000, { duration: 0.8, fs, amp: 0.5 })) },

	// Sound Effects (120-127)
	{ name: 'Guitar Fret Noise', family: 'Sound Effects', voice: sfxBurst({ color: 'white', duration: 0.08, release: 0.05, amp: 0.35 }) },
	{ name: 'Breath Noise', family: 'Sound Effects', voice: sfxBurst({ color: 'pink', duration: 0.8, attack: 0.1, release: 0.4, amp: 0.4 }) },
	{ name: 'Seashore', family: 'Sound Effects', voice: sfxBurst({ color: 'pink', duration: 2, attack: 0.6, release: 0.8, amp: 0.5, tremolo: { rate: 0.3, depth: 0.4 } }) },
	{ name: 'Bird Tweet', family: 'Sound Effects', voice: (freq, { fs = 44100 } = {}) => sustained(withFs(vibratoSource(freq * 2, { rate: 14, depth: 0.15 }), fs), { duration: 0.3, fs, attack: 0.01, decay: 0.02, sustain: 0.8, release: 0.15, amp: 0.5 }) },
	{ name: 'Telephone Ring', family: 'Sound Effects', voice: (freq, { fs = 44100 } = {}) => tremoloFx(osc(freq, { duration: 1, fs, type: 'square', amp: 0.5 }), { rate: 20, depth: 1, fs }) },
	{ name: 'Helicopter', family: 'Sound Effects', voice: sfxBurst({ color: 'brown', duration: 1.5, attack: 0.05, release: 0.2, amp: 0.5, tremolo: { rate: 8, depth: 0.6 } }) },
	{ name: 'Applause', family: 'Sound Effects', voice: sfxBurst({ color: 'white', duration: 1.5, attack: 0.2, release: 0.4, amp: 0.45 }) },
	{ name: 'Gunshot', family: 'Sound Effects', voice: (freq, o) => sfxBurst({ color: 'white', duration: 0.4, attack: 0.001, release: 0.35, amp: 0.7, metallic: true })(freq, o) },
]

// ---------------------------------------------------------------------------------------
// GM.percussion — channel-10 key map, keys 35-81 per the GM1 Percussion Key Map
// ---------------------------------------------------------------------------------------

// adapt a (opts) => Float32Array percussion hit into the (freq, opts) Voice contract —
// percussion is a one-shot per key, not a pitched instrument, so `freq` is ignored and the
// note's held duration doesn't extend a drum hit (matches how drum machines/GM modules work).
const percVoice = (fn) => (freq, { fs = 44100 } = {}) => fn(fs)

const kickV = (base, drop, dur) => percVoice(fs => membrane(base, { drop, duration: dur, fs, amp: 0.95 }))
const snareV = (tone, dur) => percVoice(fs => mix([[noiseDrum({ duration: dur, fs, amp: 0.85 }), 1], [membrane(tone, { duration: dur * 0.6, fs, amp: 0.5, drop: 1.5 }), 1]]))
const hatV = (dur, bright = 8500) => percVoice(fs => mix([[metal(bright, { duration: dur, fs, amp: 0.5 }), 1], [noiseDrum({ duration: dur, fs, amp: 0.35 }), 0.6]]))
const cymbalV = (dur, bright = 6000, amp = 0.55) => percVoice(fs => metal(bright, { duration: dur, fs, amp }))
const tomV = (pitch, dur = 0.35) => percVoice(fs => membrane(pitch, { drop: 2, duration: dur, fs, amp: 0.8 }))
const cowbellV = (base, t60 = 0.35) => percVoice(fs => modal(base, { model: 'tube-closed', t60, nmodes: 2, fs, amp: 0.7 }))
const congaV = (pitch, dur = 0.2) => percVoice(fs => membrane(pitch, { drop: 1.5, duration: dur, fs, amp: 0.75 }))
const shakerV = (dur, seed) => percVoice(fs => noiseDrum({ duration: dur, fs, amp: 0.5, seed }))
const woodblockV = (pitch, dur = 0.08) => percVoice(fs => modal(pitch, { model: 'bar', t60: 0.15, nmodes: 3, fs, amp: 0.7 }))
const triangleV = (dur, mute) => percVoice(fs => { let d = modal(1600, { model: 'tube-open', t60: mute ? 0.08 : dur, nmodes: 6, fs, amp: 0.5 }); return mute ? d.subarray(0, Math.round(0.1 * fs)) : d })
const whistleV = (dur) => percVoice(fs => osc(2000, { duration: dur, fs, type: 'sine', amp: 0.4 }))
const guiroV = (dur) => percVoice(fs => tremoloFx(noiseDrum({ duration: dur, fs, amp: 0.4 }), { rate: 25, depth: 0.7, fs }))
const clickV = (dur = 0.03, amp = 0.4) => percVoice(fs => noiseDrum({ duration: dur, fs, amp }))
// friction-drum glide (cuica) — vibratoSource's pitch wobble stands in for the stick-friction
// pitch bend, amplitude-shaped into a short (muted) or longer decaying (open) hit.
const cuicaV = (dur, decay) => percVoice(fs => {
	let d = Float32Array.from(vibratoSource(300, { rate: decay ? 1.5 : 3, depth: decay ? 0.25 : 0.2 })(dur, fs))
	for (let i = 0; i < d.length; i++) d[i] *= 0.5 * (decay ? Math.exp(-i / d.length * 3) : 1)
	return d
})

const percussion = {
	35: { name: 'Acoustic Bass Drum', voice: kickV(55, 4, 0.5) },
	36: { name: 'Bass Drum 1', voice: kickV(55, 3, 0.45) },
	37: { name: 'Side Stick', voice: clickV(0.04, 0.5) },
	38: { name: 'Acoustic Snare', voice: snareV(180, 0.2) },
	39: { name: 'Hand Clap', voice: shakerV(0.12, 21) },
	40: { name: 'Electric Snare', voice: snareV(200, 0.18) },
	41: { name: 'Low Floor Tom', voice: tomV(80) },
	42: { name: 'Closed Hi-Hat', voice: hatV(0.06) },
	43: { name: 'High Floor Tom', voice: tomV(105) },
	44: { name: 'Pedal Hi-Hat', voice: hatV(0.08, 7500) },
	45: { name: 'Low Tom', voice: tomV(130) },
	46: { name: 'Open Hi-Hat', voice: hatV(0.3) },
	47: { name: 'Low-Mid Tom', voice: tomV(155) },
	48: { name: 'Hi-Mid Tom', voice: tomV(180) },
	49: { name: 'Crash Cymbal 1', voice: cymbalV(1.2, 5500, 0.55) },
	50: { name: 'High Tom', voice: tomV(200) },
	51: { name: 'Ride Cymbal 1', voice: cymbalV(0.8, 7000, 0.5) },
	52: { name: 'Chinese Cymbal', voice: cymbalV(1, 4500, 0.5) },
	53: { name: 'Ride Bell', voice: cymbalV(0.5, 9000, 0.45) },
	54: { name: 'Tambourine', voice: percVoice(fs => mix([[shakerV(0.15, 27)(0, { fs }), 1], [metal(9500, { duration: 0.15, fs, amp: 0.35 }), 1]])) },
	55: { name: 'Splash Cymbal', voice: cymbalV(0.5, 6500, 0.5) },
	56: { name: 'Cowbell', voice: cowbellV(560) },
	57: { name: 'Crash Cymbal 2', voice: cymbalV(1.2, 5000, 0.55) },
	58: { name: 'Vibraslap', voice: percVoice(fs => mix([[noiseDrum({ duration: 0.4, fs, amp: 0.4 }), 1], [metal(1200, { duration: 0.4, fs, amp: 0.3 }), 1]])) },
	59: { name: 'Ride Cymbal 2', voice: cymbalV(0.8, 6500, 0.5) },
	60: { name: 'Hi Bongo', voice: congaV(300, 0.12) },
	61: { name: 'Low Bongo', voice: congaV(220, 0.15) },
	62: { name: 'Mute Hi Conga', voice: congaV(260, 0.08) },
	63: { name: 'Open Hi Conga', voice: congaV(260, 0.25) },
	64: { name: 'Low Conga', voice: congaV(180, 0.25) },
	65: { name: 'High Timbale', voice: percVoice(fs => mix([[congaV(400, 0.15)(0, { fs }), 1], [metal(2500, { duration: 0.1, fs, amp: 0.2 }), 1]])) },
	66: { name: 'Low Timbale', voice: percVoice(fs => mix([[congaV(300, 0.18)(0, { fs }), 1], [metal(2000, { duration: 0.12, fs, amp: 0.2 }), 1]])) },
	67: { name: 'High Agogo', voice: cowbellV(900, 0.25) },
	68: { name: 'Low Agogo', voice: cowbellV(650, 0.3) },
	69: { name: 'Cabasa', voice: shakerV(0.1, 33) },
	70: { name: 'Maracas', voice: shakerV(0.08, 37) },
	71: { name: 'Short Whistle', voice: whistleV(0.15) },
	72: { name: 'Long Whistle', voice: whistleV(0.5) },
	73: { name: 'Short Guiro', voice: guiroV(0.15) },
	74: { name: 'Long Guiro', voice: guiroV(0.5) },
	75: { name: 'Claves', voice: woodblockV(2500, 0.06) },
	76: { name: 'Hi Wood Block', voice: woodblockV(1200, 0.1) },
	77: { name: 'Low Wood Block', voice: woodblockV(800, 0.12) },
	78: { name: 'Mute Cuica', voice: cuicaV(0.1, false) },
	79: { name: 'Open Cuica', voice: cuicaV(0.35, true) },
	80: { name: 'Mute Triangle', voice: triangleV(0.6, true) },
	81: { name: 'Open Triangle', voice: triangleV(1.5, false) },
}

export const GM = { programs, percussion }

/** Look up the built-in synth voice for a GM program number (0-127). */
export function voiceFor (program) {
	if (!Number.isInteger(program) || program < 0 || program > 127) throw new RangeError(`midi-render: program must be an integer 0..127, got ${program}`)
	return programs[program].voice
}
