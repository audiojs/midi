# @audio/midi

> Symbolic ↔ audio bridge — SMF parse/write, roundtrip-tested.

| Package | Status | What |
|---|---|---|
| `@audio/midi-parse` | ✔ | SMF → `{tracks, tempos, notes, duration}` |
| `@audio/midi-write` | ✔ | notes → SMF format-0 bytes |
| `@audio/midi-soundfont` | deferred | render via SF2 or [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) banks — needs an asset-strategy decision first (real SF2 engine vs. ~100 MB/instrument pre-rendered banks, neither belongs in an npm atom as-is) |

```js
import { parse, write } from '@audio/midi'

let smf = write(notes, { bpm: 120 })          // notes → SMF bytes
let { notes, tempos, duration } = parse(smf)  // SMF bytes → notes
```

Render through any synth voice today, no soundfont needed:

```js
import { parse } from '@audio/midi'
import poly from '@audio/synth-poly'

let audio = poly(parse(smf).notes, { voice: pluck })
```

Consumers: singing-to-midi tool (site todo), signal/strudel-style editors, `@audio/note` for pitch math.
