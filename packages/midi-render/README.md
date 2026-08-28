# @audio/midi-render [![npm](https://img.shields.io/npm/v/@audio/midi-render)](https://www.npmjs.com/package/@audio/midi-render) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

MIDI → PCM — General MIDI synth render, no soundfont, no samples

```
npm install @audio/midi-render
```

```js
import render, { GM, voiceFor } from '@audio/midi-render'
```

A synth-GM: every one of the 128 [General MIDI Level 1](https://www.midi.org/specifications/midi1-specifications/general-midi-specifications/general-midi-1-sound-set) programs and every percussion key (35-81) maps to an `@audio/synth-*` generator — FM (Chowning 1973), Karplus-Strong plucked strings (Karplus & Strong 1983), and modal resonator banks (Fletcher & Rossing, *The Physics of Musical Instruments*, 1998) — instead of a sampled/SF2 bank. Parses with `@audio/midi-parse`, allocates polyphony per channel with `@audio/synth-poly` (note-stealing), mixes to stereo. Zero asset weight: the whole instrument set ships as code.

```js
import render from '@audio/midi-render'
import { readFileSync } from 'fs'

let smf = readFileSync('song.mid')
let { channelData, sampleRate, duration } = render(smf)
// channelData: [Float32Array, Float32Array] (L, R) — write to WAV/whatever with @audio/encode-wav
```

```js
// override an instrument, or inspect the map
import render, { GM, voiceFor } from '@audio/midi-render'
import bell from '@audio/synth-fm'

render(smf, { programs: { 8: (freq, opts) => bell(freq, { ...opts, index: 12 }) } })
console.log(GM.programs[0].name)         // 'Acoustic Grand Piano'
console.log(voiceFor(0)(440, { fs: 44100, duration: 1, velocity: 0.8 }).length)
```

| Param | Default | |
|---|---|---|
| `fs` | `44100` | Sample rate, Hz |
| `channels` | `2` | Output channel count, `1` or `2` |
| `voices` | `32` | Max simultaneous notes per (channel, program) or (channel, drum key) — oldest is stolen with a 5ms fade |
| `tail` | `1.0` | Seconds of silence appended after the render's natural end |
| `gain` | `0.5` | Overall gain multiplier, applied before normalization |
| `normalize` | `true` | Peak-normalize to −1 dBFS if the mix exceeds it — never boosts a quieter mix |
| `programs` | — | `Record<program, Voice>` — override the GM program map |
| `drums` | — | `Record<key, Voice>` — override the GM percussion map |
| `tempoScale` | `1` | Stretches/compresses the whole schedule (`2` = twice as fast) |
| `transpose` | `0` | Semitones added to every non-percussion note |
| `bendRange` | `2` | Pitch-bend sensitivity in semitones (GM default) |

## The GM map

| Programs | Family | Synthesis |
|---|---|---|
| 0-3 | Piano (acoustic) | 2-op FM hammer transient + `synth-modal` `'string'` body; t60 scales with pitch (8s @ MIDI36 → 1.5s @ MIDI96, linear) — inharmonicity 0.0002 |
| 4-5 | Piano (electric) | `synth-fm`'s `epiano()` preset, two ratio/index voicings |
| 6-7 | Harpsichord/Clavinet | `synth-pluck` (Karplus-Strong), bright/fast damping |
| 8-15 | Chromatic percussion | `synth-modal` `'bar'`/`'plate'` (Fletcher & Rossing mode tables) or `synth-fm`'s `bell()`; vibraphone gets a tremolo LFO, marimba/xylophone use `strike` position |
| 16-23 | Organ | 9-partial additive drawbar (Hammond footages 16'-1', ratios 1/2/3/4/6/8/10/12/16) with slow vibrato, sustain-while-held envelope; accordion/harmonica = sawtooth + reed FM |
| 24-31 | Guitar | `synth-pluck`, damping/lowpass/drive per articulation (nylon 0.994 … distortion `tanh` drive 8) |
| 32-39 | Bass | `synth-pluck` (acoustic/electric/slap, damping 0.993-0.999 + percussive click) or oscillator + ADSR (synth bass 1/2) |
| 40-55 | Strings/ensemble | Detuned oscillator pairs/triples (±5-10 cents) through a slow ADSR; pizzicato = pluck, timpani = `synth-drum` `membrane()`, choir/voice = a wide detuned pad (no formant/vowel synth in the ecosystem — documented fallback) |
| 56-63 | Brass | `synth-fm` with a **rising** modulation index (index climbs toward `indexFloor` over the attack — Chowning 1973's brass patch; `fm()`'s exponential decay toward a floor runs upward just as well as downward) |
| 64-71 | Reed (sax/oboe/bassoon) | `synth-fm` 2-op, ratio ≈ 2; clarinet is a plain square wave (a cylindrical closed-reed bore suppresses even harmonics — the same spectrum a square wave has) |
| 72-79 | Pipe (flute family) | Sine + vibrato + pink-noise breath (−16 to −36 dB below the tone, per instrument) |
| 80-87 | Synth lead | Oscillator + fast ADSR, one or two per patch (fifths, sub-oscillator bass+lead) |
| 88-95 | Synth pad | Detuned oscillator stack, long attack |
| 96-103 | Synth FX | `bell()`/noise textures — deliberately loose; "keep sane," not a faithful FX patch |
| 104-111 | Ethnic | `synth-pluck`/`synth-fm`/detuned-pad approximations; bagpipe is a sustained reed drone |
| 112-119 | Percussive (tuned) | `synth-modal` bar/plate or `synth-drum` `membrane()`; reverse cymbal = a time-reversed `metal()` |
| 120-127 | Sound effects | Colored-noise bursts (`synth-noise`), never silent |
| 35-81 (ch. 10) | GM percussion key map | `synth-drum`'s `membrane()`/`metal()`/`noiseDrum()` and `synth-modal` `'tube-closed'` (cowbell/agogo), per-key durations/pitches from the spec (kick 35/36, snare 38/40 = noise+membrane blend, hats 42/44/46, crashes/rides 49-59, toms 41-50 at 80-200 Hz, latin percussion 60-81) |

Every program/key is covered — `render()` never falls silent on a valid GM number, and an out-of-map percussion key gets a short click rather than nothing.

Velocity maps to amplitude through a `v^1.5` power curve (perceptually closer to a loudness control than raw linear velocity), applied once before `synth-poly`'s own linear gain stage.

## MIDI control handling

- **Program changes** — honored per note, per channel (mid-track changes apply to every note from that point on).
- **CC7 (channel volume)** — read per note (the value in effect at the note's start time); default 100/127 per the GM System Level 1 spec's default controller value.
- **CC10 (pan)** — equal-power, read **once per channel** at the value in effect at the channel's first note. Mid-channel pan automation is not applied per note — each channel renders to one mono buffer before panning, so a single pan value applies to the whole channel. Default center (64).
- **CC64 (sustain pedal)** — extends a note's held duration until the pedal releases (or the end of the piece, if never released). Applied per note, before synthesis.
- **Pitch bend** — read once per note, at the value in effect when the note starts, and applied as a constant per-note transposition (`bendRange` semitones at full deflection). Bend automation *during* a held note is not applied — there's no per-sample pitch modulation. Custom RPN 0,0 bend-range messages are not parsed; only the `bendRange` option changes the default ±2 semitones.
- **Percussion (channel 10)** — program changes are ignored; the fixed GM1 percussion map always applies (matching GM Level 1, which defines a single kit).

## Performance

Rendering is deterministic per `(instrument, freq, duration)` — repeated notes (very common in real MIDI — the same pitch/duration/instrument recurs constantly) reuse a cached `Float32Array` within one `render()` call instead of re-synthesizing. A 2-minute, 8-channel, ~1500-note file renders in ≈4s on a laptop CPU (measured in `test.js`). Each channel is rendered and mixed down before moving to the next — the renderer never holds every note's audio in memory at once.

**Use when:** you need audio from a Standard MIDI File and don't want a soundfont/sample-bank dependency — previews, MIDI-to-audio-in-the-browser, test fixtures, procedurally generated music. Not a substitute for a real soundfont/sample player when sample-accurate GM-compatible timbre matters (a game engine's music, a DAW export) — the instrument bank here is a from-scratch synthesis approximation of each GM voice, not a recording of one.

---

Part of [@audio/midi](https://github.com/audiojs/midi) — the midi family umbrella.

MIT © [audiojs](https://github.com/audiojs)
