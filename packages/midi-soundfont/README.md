# @audio/midi-soundfont

> Soundfont sampler — render MIDI through SF2/pre-rendered banks (midi-js-soundfonts)

**Deferred — deliberately.** Two honest designs, neither trivial: a real SF2 engine (RIFF parse,
sample extraction, generator/modulator model, loop points, envelopes) or a pre-rendered-bank player
(midi-js-soundfonts assets — a licensing/packaging decision, since the banks are ~100 MB per
instrument set and don't belong in an npm atom). Needs that asset-strategy decision first.
Interim: `@audio/midi-parse` + `@audio/synth-poly` render MIDI through any synth voice today —
`poly(parse(smf).notes, { voice: pluck })`.
