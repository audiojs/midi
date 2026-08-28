import t, { ok, almost, throws } from 'tst'
import { readFileSync } from 'fs'
import write from '@audio/midi-write'
import parse from '@audio/midi-parse'
import yin from '@audio/pitch-yin'
import render, { GM, voiceFor } from './render.js'

// fixtures/bwv846-prelude.mid — J.S. Bach, Das Wohltemperierte Clavier I, Praeludium I
// (BWV 846), MIDI realization by the Mutopia Project (piece id 5,
// https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=5), Copyright: Public Domain
// (CC0/public-domain mark, per the page's "Licensing" section) — downloaded 2026-08-28 from
// https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.mid (4676
// bytes, well under the 50 KB fixture budget).

// ---- shared measurement helpers (typed-array loops — no spread/Array.from on multi-second
// buffers, which would blow the call stack or be needlessly slow) ----
function peakOf (chans) { let p = 0; for (let c of chans) for (let i = 0; i < c.length; i++) { let a = Math.abs(c[i]); if (a > p) p = a } return p }
function rmsOf (d, from = 0, to = d.length) { let s = 0; for (let i = from; i < to; i++) s += d[i] * d[i]; return Math.sqrt(s / (to - from)) }
function hasNaN (d) { for (let i = 0; i < d.length; i++) if (Number.isNaN(d[i])) return true; return false }
function goertzel (d, freq, fs) {
	let w = 2 * Math.PI * freq / fs, c = 2 * Math.cos(w), s0 = 0, s1 = 0, s2 = 0
	for (let i = 0; i < d.length; i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0 }
	return s1 * s1 + s2 * s2 - c * s1 * s2
}
// onset finder: first time a 15ms-window RMS envelope crosses 1.5x its own pre-onset local
// baseline, searching [center-tol, center+searchAfter]. Two simpler approaches don't hold up
// on a synthesized, physically-modeled voice: (1) "the loudest window in a wide neighborhood"
// fires late — a struck/plucked voice's envelope can keep rising for tens of ms from beating
// between its own component layers (e.g. acoustic piano's FM hammer transient vs. its modal
// string body aren't phase-aligned); (2) a threshold relative to that *global* peak fires early
// when the previous note's still-decaying tail is present (piano rings for seconds). Comparing
// against the *local* baseline immediately before the candidate — 0 when the candidate sits at
// the very start of the buffer — sidesteps both: the tail's slow decay barely moves the
// baseline, so only a genuinely new attack crosses 1.5x it. The 15ms window (~4 cycles at the
// lowest note under test, ~260 Hz) smooths out sub-period envelope noise a shorter window would alias.
function onsetTime (mono, fs, center, { tol = 0.01, searchAfter = 0.06, baselineFrom = 0.06, baselineTo = 0.02, mult = 1.5, scanWin = 0.003 } = {}) {
	// baseline: a wider (15ms) window — needs smoothing to average out envelope beating
	let baseA = Math.max(0, Math.round((center - baselineFrom) * fs))
	let baseB = Math.max(0, Math.round((center - baselineTo) * fs))
	let baseline = baseB > baseA ? rmsOf(mono, baseA, baseB) : 0
	let threshold = baseline * mult + 1e-6
	// crossing scan: a narrow window — a wide one "lights up" as soon as it merely overlaps
	// the true onset (as little as ~1/3 of it, since RMS ~ sqrt(overlap fraction) for a step
	// change), which for a 15ms window alone can misreport the onset up to ~10ms early
	let w = Math.max(1, Math.round(scanWin * fs)), step = Math.max(1, Math.round(0.001 * fs))
	let a = Math.max(0, Math.round((center - tol) * fs)), b = Math.min(mono.length, Math.round((center + searchAfter) * fs))
	for (let i = a; i + w <= b; i += step) if (rmsOf(mono, i, i + w) >= threshold) return i / fs
	return b / fs // never crossed — clearly outside tolerance, fails the caller's assertion
}
// spectral centroid over a small Goertzel filterbank (drum classification — kick vs. snare)
function centroidOf (d, fs) {
	let freqs = [80, 150, 250, 400, 600, 900, 1300, 1800, 2500, 3500, 5000, 7000]
	let num = 0, den = 0
	for (let f of freqs) { let e = goertzel(d, f, fs); num += f * e; den += e }
	return num / den
}
// longest 200ms-or-wider window under `thresholdDb` inside [0, upTo] seconds — dropout scan
function firstDropout (d, fs, upTo, winSec = 0.2, thresholdDb = -60) {
	let win = Math.round(winSec * fs), end = Math.min(d.length, Math.round(upTo * fs))
	let threshold = Math.pow(10, thresholdDb / 20)
	for (let i = 0; i + win <= end; i += Math.round(win / 2)) {
		if (rmsOf(d, i, i + win) < threshold) return i / fs
	}
	return -1
}

// ---- a minimal raw-SMF builder for CC7/CC10/CC64/program-change fixtures — midi-write's
// write() only encodes {time, duration, midi, velocity, channel} note events, so tests that
// need controller/program messages build the SMF bytes directly (same structure as
// midi-write's own internals: one format-0 track, delta-VLQ events, running status not
// required since every event re-states its status byte).
function assembleSmf (evs, division) {
	let sorted = evs.slice().sort((a, b) => a.tick - b.tick || a.pri - b.pri)
	let out = []
	const vlq = (v) => { let stack = [v & 0x7f]; while (v >>= 7) stack.push((v & 0x7f) | 0x80); out.push(...stack.reverse()) }
	let last = 0
	for (let e of sorted) { vlq(e.tick - last); out.push(...e.bytes); last = e.tick }
	vlq(0); out.push(0xff, 0x2f, 0x00)
	let head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, division >> 8, division & 0xff]
	let tlen = out.length
	let trk = [0x4d, 0x54, 0x72, 0x6b, tlen >>> 24 & 0xff, tlen >> 16 & 0xff, tlen >> 8 & 0xff, tlen & 0xff]
	return Uint8Array.from([...head, ...trk, ...out])
}
// single note on channel 0, with optional CC events and sustain-pedal down/up times (seconds)
function buildSingleNoteSmf ({ program = 0, cc = [], midi = 69, velocity = 100, noteAt = 0, duration = 1, bpm = 120, division = 480, sustainDown = null, sustainUp = null } = {}) {
	let usPerBeat = Math.round(60e6 / bpm)
	let toTick = (s) => Math.max(0, Math.round(s * 1e6 / usPerBeat * division))
	let evs = [
		{ tick: 0, pri: 0, bytes: [0xff, 0x51, 0x03, usPerBeat >> 16 & 0xff, usPerBeat >> 8 & 0xff, usPerBeat & 0xff] },
		{ tick: 0, pri: 0, bytes: [0xc0, program] },
	]
	for (let c of cc) evs.push({ tick: toTick(c.t ?? 0), pri: 0, bytes: [0xb0, c.cc, c.val] })
	if (sustainDown != null) evs.push({ tick: toTick(sustainDown), pri: 0, bytes: [0xb0, 64, 127] })
	if (sustainUp != null) evs.push({ tick: toTick(sustainUp), pri: 0, bytes: [0xb0, 64, 0] })
	evs.push({ tick: toTick(noteAt), pri: 2, bytes: [0x90, midi, velocity] })
	evs.push({ tick: toTick(noteAt + duration), pri: 1, bytes: [0x80, midi, 0] })
	return assembleSmf(evs, division)
}

t('single note (A4=69, 1s, program 0) — pitch, peak, no NaN', () => {
	let smf = write([{ time: 0, duration: 1, midi: 69, velocity: 0.8, channel: 0 }], { bpm: 120 })
	let r = render(smf)
	ok(!hasNaN(r.channelData[0]) && !hasNaN(r.channelData[1]), 'no NaN')
	let peak = peakOf(r.channelData)
	ok(peak <= 1, `peak ${peak.toFixed(4)} <= 1`)

	// program 0 (acoustic piano) rings per its own pitch-scaled t60 — physically independent
	// of the written note-on length (see gm.js's acousticPiano: t60 = 8s @ MIDI36 -> 1.5s @
	// MIDI96, linear). At MIDI 69: t60 = 8 + (1.5-8)*((69-36)/(96-36)) ≈ 4.425s. The modal
	// layer's own render length is t60*1.2+0.05 (its documented default-duration formula);
	// synth-poly pads 0.5s past the last voice's cutoff; render() appends the default 1s tail.
	let t60 = 8 + (1.5 - 8) * ((69 - 36) / (96 - 36))
	let expected = (t60 * 1.2 + 0.05) + 0.5 + 1.0
	ok(r.duration >= 1 + 1.0 - 0.05, `duration ${r.duration.toFixed(2)} >= note+tail (never truncated)`)
	almost(r.duration, expected, 0.3, `duration ${r.duration.toFixed(2)} ≈ ${expected.toFixed(2)} (piano t60 ring, not a bare note+tail)`)

	// pitch on the sustain region: well inside the 1s note-on and the multi-second ring
	let fs = r.sampleRate
	let region = r.channelData[0].subarray(Math.round(0.3 * fs), Math.round(0.7 * fs))
	let est = yin(region, { fs })
	ok(est, 'pitch detected')
	almost(est.freq, 440, 440 * 0.01, `${est.freq.toFixed(2)} Hz ≈ 440 Hz ±1%`)
})

t('chord (C4 E4 G4) — Goertzel peaks at 261.6/329.6/392 Hz, each >10x the 300 Hz reference bin', () => {
	let notes = [
		{ time: 0, duration: 1, midi: 60, velocity: 0.8, channel: 0 },
		{ time: 0, duration: 1, midi: 64, velocity: 0.8, channel: 0 },
		{ time: 0, duration: 1, midi: 67, velocity: 0.8, channel: 0 },
	]
	let r = render(write(notes, { bpm: 120 }), { normalize: false })
	let fs = r.sampleRate
	let region = r.channelData[0].subarray(Math.round(0.2 * fs), Math.round(0.2 * fs) + 8192)
	let eRef = goertzel(region, 300, fs)
	for (let [name, f] of [['C4', 261.63], ['E4', 329.63], ['G4', 392.00]]) {
		let e = goertzel(region, f, fs)
		ok(e > 10 * eRef, `${name} (${f} Hz) energy ${e.toExponential(2)} > 10x @300Hz ${eRef.toExponential(2)}`)
	}
})

t('GM program map — every program 0-127 renders 0.5s non-silently, no throw', () => {
	for (let p = 0; p < 128; p++) {
		let voice = voiceFor(p)
		let d = voice(440, { fs: 44100, duration: 0.5, velocity: 0.8 })
		ok(d instanceof Float32Array && d.length > 0, `program ${p} "${GM.programs[p].name}" returns audio`)
		ok(!hasNaN(d), `program ${p} "${GM.programs[p].name}" no NaN`)
		let rms = rmsOf(d)
		ok(rms > 1e-4, `program ${p} "${GM.programs[p].name}" RMS ${rms.toExponential(2)} > 1e-4`)
	}
	ok(GM.programs.length === 128, '128 programs')
})

t('GM percussion map — every key 35-81 renders non-silently', () => {
	for (let k = 35; k <= 81; k++) {
		let entry = GM.percussion[k]
		ok(entry, `key ${k} is defined`)
		let d = entry.voice(220, { fs: 44100, duration: 0.3, velocity: 0.8 })
		ok(!hasNaN(d), `key ${k} "${entry.name}" no NaN`)
		let rms = rmsOf(d)
		ok(rms > 1e-4, `key ${k} "${entry.name}" RMS ${rms.toExponential(2)} > 1e-4`)
	}
})

t('channel 10 drums — kick@0 / snare@0.5 onsets within 10ms, kick centroid < snare centroid', () => {
	let notes = [
		{ time: 0, duration: 0.1, midi: 36, velocity: 1, channel: 9 },
		{ time: 0.5, duration: 0.1, midi: 38, velocity: 1, channel: 9 },
	]
	let r = render(write(notes, { bpm: 120 }), { normalize: false })
	let fs = r.sampleRate, mono = r.channelData[0]

	let kickT = onsetTime(mono, fs, 0)
	let snareT = onsetTime(mono, fs, 0.5)
	ok(Math.abs(kickT - 0) < 0.01, `kick onset ${kickT.toFixed(4)}s ≈ 0`)
	ok(Math.abs(snareT - 0.5) < 0.01, `snare onset ${snareT.toFixed(4)}s ≈ 0.5`)

	let kc = centroidOf(mono.subarray(0, Math.round(0.1 * fs)), fs)
	let sc = centroidOf(mono.subarray(Math.round(0.5 * fs), Math.round(0.6 * fs)), fs)
	ok(kc < sc, `kick centroid ${kc.toFixed(0)} Hz < snare centroid ${sc.toFixed(0)} Hz`)
})

t('CC7 volume halves RMS, CC10 hard-left silences the right channel, CC64 sustain extends a note', () => {
	// CC7: 127 (full) vs 64 (~half, linear MIDI convention) — 20*log10(64/127) ≈ -5.95 dB
	let full = render(buildSingleNoteSmf({ cc: [{ cc: 7, val: 127 }] }), { normalize: false })
	let half = render(buildSingleNoteSmf({ cc: [{ cc: 7, val: 64 }] }), { normalize: false })
	let fs = full.sampleRate
	let rFull = rmsOf(full.channelData[0], 0, Math.round(0.3 * fs))
	let rHalf = rmsOf(half.channelData[0], 0, Math.round(0.3 * fs))
	almost(20 * Math.log10(rHalf / rFull), 20 * Math.log10(64 / 127), 0.2, 'CC7 64/127 scales RMS by exactly 64/127 (linear controller gain)')

	// CC10 hard-left (val=0): equal-power pan puts 100% in L, 0% in R
	let panL = render(buildSingleNoteSmf({ cc: [{ cc: 10, val: 0 }] }), { normalize: false })
	let rL = rmsOf(panL.channelData[0]), rR = rmsOf(panL.channelData[1])
	ok(rR < rL * 0.01, `hard-left: right RMS ${rR.toExponential(2)} < 1% of left RMS ${rL.toExponential(2)}`)

	// CC64 sustain: program 16 (Drawbar Organ) sustains at full amplitude for exactly its
	// `duration` opt (a "sustain"-type voice, unlike piano/pluck, which ring independently of
	// note-off) — a 50ms note with the pedal held 0..1.5s should still be at full level at
	// t=1s, while the same note without sustain has long since finished (duration+release
	// ≈ 0.17s, plus synth-poly's 0.5s pad ≈ 0.67s << 1s).
	let noSustain = render(buildSingleNoteSmf({ program: 16, midi: 69, noteAt: 0.1, duration: 0.05 }), { normalize: false })
	let sustained = render(buildSingleNoteSmf({ program: 16, midi: 69, noteAt: 0.1, duration: 0.05, sustainDown: 0, sustainUp: 1.5 }), { normalize: false, tail: 0.3 })
	let probe = Math.round(1.0 * fs), win = Math.round(0.05 * fs)
	let noSustainLevel = probe + win <= noSustain.channelData[0].length ? rmsOf(noSustain.channelData[0], probe, probe + win) : 0
	let sustainedLevel = rmsOf(sustained.channelData[0], probe, probe + win)
	ok(sustainedLevel > 1e-3, `sustained note still audible at t=1s: RMS ${sustainedLevel.toExponential(2)}`)
	ok(sustainedLevel > noSustainLevel * 5, `pedal extends audible length: sustained ${sustainedLevel.toExponential(2)} vs unsustained ${noSustainLevel.toExponential(2)}`)
})

t('tempo map (120bpm then 60bpm) — note onsets land at the tempo-mapped seconds', () => {
	// same hand-built SMF pattern as @audio/midi's own root test.js (division 960, tempo
	// 500000us (120bpm) at tick 0, tempo 1000000us (60bpm) at tick 960): note A on/off spans
	// tick 0..960 (= 0.5s at 120bpm), note B on/off spans tick 960..1920 (= 1s at 60bpm) —
	// so note B's onset is at t=0.5s.
	let bytes = Uint8Array.from([
		0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x03, 0xc0,
		0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 29,
		0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
		0x00, 0x90, 60, 100,
		0x87, 0x40, 60, 0,
		0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
		0x00, 0x90, 62, 100,
		0x87, 0x40, 62, 0,
		0x00, 0xff, 0x2f, 0x00,
	])
	let r = render(bytes, { normalize: false })
	let fs = r.sampleRate, mono = r.channelData[0]
	let onsetA = onsetTime(mono, fs, 0)
	let onsetB = onsetTime(mono, fs, 0.5)
	ok(Math.abs(onsetA - 0) < 0.01, `note A onset ${onsetA.toFixed(4)}s ≈ 0`)
	ok(Math.abs(onsetB - 0.5) < 0.01, `note B onset ${onsetB.toFixed(4)}s ≈ 0.5 (tempo-mapped)`)
})

t('polyphony — 40 simultaneous notes with voices:32 steals without throwing; normalize:false may exceed 1', () => {
	let notes = []
	for (let i = 0; i < 40; i++) notes.push({ time: 0, duration: 1, midi: 40 + i, velocity: 0.9, channel: 0 })
	let smf = write(notes, { bpm: 120 })

	let normalized = render(smf, { voices: 32, normalize: true })
	ok(!hasNaN(normalized.channelData[0]), 'no NaN (normalized)')
	let peakN = peakOf(normalized.channelData)
	ok(peakN <= 1 + 1e-6, `peak ${peakN.toFixed(4)} <= 1 after normalize`)

	let unnormalized = render(smf, { voices: 32, normalize: false, gain: 1 })
	ok(!hasNaN(unnormalized.channelData[0]), 'no NaN (unnormalized)')
	let peakU = peakOf(unnormalized.channelData)
	ok(peakU > 1, `peak ${peakU.toFixed(4)} > 1 without normalize (40-note unison-onset pile-up clips)`)
})

t('speed — ~2min / 8 channels / ~1500 notes renders in < 10s', () => {
	let seed = 42
	const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
	let notes = []
	for (let i = 0; i < 1500; i++) {
		notes.push({ time: rnd() * 118, duration: 0.15 + rnd() * 0.35, midi: 40 + Math.floor(rnd() * 40), velocity: 0.5 + rnd() * 0.5, channel: i % 8 })
	}
	let smf = write(notes, { bpm: 120 })
	let t0 = Date.now()
	let r = render(smf)
	let ms = Date.now() - t0
	ok(ms < 10000, `rendered 1500 notes / 8ch / ${r.duration.toFixed(1)}s output in ${ms}ms`)
})

t('real SMF — Bach BWV 846 Prelude (Mutopia, public domain): duration matches, no dropout > 200ms', async () => {
	let bytes = new Uint8Array(readFileSync(new URL('./fixtures/bwv846-prelude.mid', import.meta.url)))
	let parsed = parse(bytes)
	ok(parsed.notes.length > 100, `fixture parses: ${parsed.notes.length} notes, ${parsed.duration.toFixed(1)}s`)

	let r = render(parsed) // exercise the pre-parsed ParseResult input path
	ok(!hasNaN(r.channelData[0]), 'no NaN')
	ok(r.duration >= parsed.duration, `render duration ${r.duration.toFixed(2)} >= parsed duration ${parsed.duration.toFixed(2)} (never truncated)`)
	// upper bound: parsed duration + default 1s tail + worst-case piano ring (t60=8s at the
	// lowest anchor MIDI36 -> modal duration 8*1.2+0.05=9.65s) + synth-poly's 0.5s pad
	ok(r.duration <= parsed.duration + 1.0 + 9.65 + 0.5 + 0.5, `render duration ${r.duration.toFixed(2)} within the documented tail/ring bound`)

	let dropoutAt = firstDropout(r.channelData[0], r.sampleRate, parsed.duration)
	ok(dropoutAt < 0, dropoutAt < 0 ? 'no >200ms window below -60dBFS inside the piece' : `dropout at ${dropoutAt.toFixed(2)}s`)
})

t('input validation — throws on bad channels/tempoScale/program, and on unparseable input', () => {
	let smf = write([{ time: 0, duration: 0.1, midi: 60 }])
	throws(() => render(smf, { channels: 3 }), 'channels must be 1 or 2')
	throws(() => render(smf, { tempoScale: 0 }), 'tempoScale must be > 0')
	throws(() => voiceFor(128), 'program out of range')
	throws(() => voiceFor(1.5), 'program not an integer')
	throws(() => render(new Uint8Array([1, 2, 3, 4])), 'not an SMF')
})
