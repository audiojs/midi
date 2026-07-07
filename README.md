# @audio/midi

> Symbolic ↔ audio bridge. All planned.

| Package | What |
|---|---|
| `@audio/midi-parse` | SMF → events (tempo map, tracks) |
| `@audio/midi-write` | events → SMF — `mir-transcribe` output, `tune-midi` reference input |
| `@audio/midi-soundfont` | render via [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) banks |

Consumers: singing-to-midi tool (site todo), signal/strudel-style editors, `@audio/note` for pitch math.
