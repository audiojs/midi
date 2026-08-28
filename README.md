# @audio/midi

> Symbolic & timed formats — SMF parse/write/render, MusicXML + ABC notation, subtitles. Roundtrip-tested.

| Package | Status | What |
|---|---|---|
| `@audio/midi-parse` | ✔ | SMF → `{tracks, tempos, notes, duration}` |
| `@audio/midi-write` | ✔ | notes → SMF format-0 bytes |
| `@audio/midi-render` | ✔ | SMF → PCM through the `@audio/synth-*` atoms — a GM Level 1 map (128 programs + percussion), no soundfont, no samples |
| `@audio/musicxml` | ✔ | notes → MusicXML 4.0 (quantize, ties, chords, voices, key spelling, percussion) + parser; ABC 2.1 writer |
| `@audio/subtitle` | ✔ | SRT / WebVTT / LRC (enhanced word timing) / TTML parse + write; `fromWords` for ASR/alignment output |
| `@audio/midi-soundfont` | deferred | render via SF2 or [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) banks — needs an asset-strategy decision first (real SF2 engine vs. ~100 MB/instrument pre-rendered banks, neither belongs in an npm atom as-is). `midi-render` is the asset-free answer. |

```js
import { parse, write, render, musicxml, subtitle } from '@audio/midi'

let smf = write(notes, { bpm: 120 })          // notes → SMF bytes
let { notes, tempos, duration } = parse(smf)  // SMF bytes → notes
let { channelData, sampleRate } = render(smf) // SMF bytes → PCM, GM synth map
let xml = musicxml(notes, { bpm: 120, key: 'G' })      // notes → sheet music
let srt = subtitle.write(cues, 'srt')                  // timed text
```

Render through any synth voice of your own choosing:

```js
import { parse } from '@audio/midi'
import poly from '@audio/synth-poly'

let audio = poly(parse(smf).notes, { voice: pluck })
```

Consumers: singing-to-midi tool (site todo), signal/strudel-style editors, `@audio/note` for pitch math.
