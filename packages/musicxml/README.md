# @audio/musicxml [![npm](https://img.shields.io/npm/v/@audio/musicxml)](https://www.npmjs.com/package/@audio/musicxml) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

MusicXML 4.0 writer/parser and ABC writer — note events → notation

```
npm install @audio/musicxml
```

```js
import write, { parse, toAbc, quantize } from '@audio/musicxml'
```

Takes the note-event shape shared by `@audio/mir-transcribe`, `@audio/mir-drums` and `@audio/midi-write` (`[{time, duration, midi, velocity}]`, seconds) and writes standard notation: MusicXML 4.0 `score-partwise` ([W3C Music Notation CG spec](https://www.w3.org/2021/06/musicxml40/)) or ABC 2.1 ([abcnotation.com standard](https://abcnotation.com/wiki/abc:standard:v2.1)). Onsets/durations are snapped to a rhythmic grid, split into a tied run where a duration isn't directly expressible (whole/half/quarter/eighth/16th/32nd/64th + dots + triplets), and spelled key-aware (sharp/flat choice + courtesy accidentals from the key signature). `parse()` reads MusicXML back into the same note-event shape. For turning MIDI note numbers into synth voices or scale math, see `@audio/note`; for the reverse direction (SMF bytes), see `@audio/midi-write`/`@audio/midi-parse`.

```js
import write, { parse, toAbc } from '@audio/musicxml'

let notes = [
  { time: 0, duration: 0.5, midi: 60, velocity: 0.8 },
  { time: 0.5, duration: 0.5, midi: 64, velocity: 0.8 },
]

let xml = write(notes, { bpm: 120, key: 0, title: 'Untitled' })   // MusicXML 4.0 string
let abc = toAbc(notes, { bpm: 120 })                              // ABC 2.1 string

let { parts } = parse(xml)                                        // back to note events
parts[0].notes   // [{time, duration, midi, velocity, voice}, …]
```

Multiple parts, percussion, and an explicit clef:

```js
write({
  parts: [
    { name: 'Melody', notes: melodyNotes, clef: 'treble' },
    { name: 'Drums', notes: drumEvents, percussion: true },   // mir-drums {time, type, strength}
  ],
}, { bpm: 100, timeSignature: [3, 4], key: 'G' })
```

| Param | Default | |
|---|---|---|
| `bpm` | `120` | Tempo, quarter-notes/minute — ignored when `tempos` is given |
| `tempos` | — | Piecewise tempo map `[{time, bpm}]`, seconds |
| `timeSignature` | `[4, 4]` | `[beats, beat-type]` |
| `key` | `0` | Circle-of-fifths position (−7..7) or a key name (`'C'`, `'G'`, `'Fm'`, `'Am'`, …) |
| `mode` | `'major'` | Ignored when `key` is a name that already encodes mode (`'Am'`) |
| `divisions` | `480` | Ticks per quarter note; bumped up automatically so every duration is exact |
| `quantize` | `16` | Rhythmic grid denominator (4, 8, 16, 32; `0` = no quantization) |
| `triplets` | `true` | Also try the 1/8 and 1/16 triplet grids per note, keep whichever fits |
| `minDuration` | one grid step | Shortest kept note, in beats |
| `title`, `composer` | — | `<work-title>` / `<creator type="composer">` |
| `software` | `'@audio/musicxml'` | `<identification><encoding><software>` |
| `pickup` | `false` | Anacrusis: shorten measure 1 to the piece's remainder-length pickup |

Each part is `{ name, notes, instrument?, percussion?, clef? }`. `clef` is `'treble' | 'bass' | 'grand' | 'percussion'`, default auto by median pitch (≥60 → treble). `'grand'` writes two staves split at middle C. `instrument` is `{ name?, channel?, program? }` (0-based, like the rest of this ecosystem — converted to MusicXML's 1-based `midi-channel`/`midi-program`). `percussion: true` reads GM channel-10 events: either mir-drums-style `{type: 'kick'|'snare'|'hihat', …}` or notes that already carry a raw `midi` number.

**Rhythm**: onsets/durations are quantized to the grid (`quantize()`, exported separately — seconds → `{beat, beats}` in quarter-note beats via a piecewise tempo map), then a duration too long for one notated value is split into a tied run, the fewest expressible values that sum to it exactly (Ross, *The Art of Music Engraving*, ch. 4). A note or rest crossing a barline is likewise split and tied. **Voices**: notes that overlap in time take separate voices (`<voice>`, `<backup>`), so a held bass under a melody keeps its length. A note joins a chord (`<chord/>`) only with notes of the same onset and end; otherwise it takes a voice that has finished, the one whose last pitch is nearest, or opens a new one, so a part has as many voices as chords sounding at once. Each voice fills every measure with rests; voice 1 is written in every measure, another voice only where it plays. **Pitch spelling** follows the key signature: diatonic notes take the key's accidental with no `<accidental>` element; a chromatic note is spelled sharp in sharp/neutral keys and flat in flat keys; a minor key's raised 7th (leading tone) is spelled as a raised natural-7th letter, not a flat of the letter above. Accidentals are scoped to the measure and voice, with courtesy naturals when a note cancels the key signature.

**ABC**: `toAbc()` writes one tune: every voice of every part is an ABC voice (`V:1`, `V:2`, …), a part's voices on one staff via `%%score`; a voice is an invisible rest (`x`) in bars where it does not play.

**Percussion**: the GM Level 1 percussion key map (MIDI Manufacturers Association, *General MIDI System Level 1*, §Percussion Key Map) for `type`↔MIDI, plus the display-step/octave convention most notation software uses for a 5-line percussion staff (kick→F4, snare→C5, closed hi-hat→G5, …). Several GM instruments share a staff position (open/closed hi-hat both sit on G5); `parse()`'s reverse lookup resolves ties by table order, so only the kick/snare/hihat trio mir-drums emits is guaranteed to round-trip exactly.

**Not done**: velocity has no standard per-note home in MusicXML, so `parse()` always returns `0.8` — it is not round-tripped. Transposing-instrument `<attributes><transpose>` is read but not applied — pitches come back exactly as written in the file, not concert pitch. `pickup` computes the anacrusis length from the total note span (`totalBeats mod beatsPerMeasure`), not from an explicit pickup length. `quantize: 0` keeps unquantized lengths, which notated values cannot hold exactly: a measure can be off by a few ticks in MusicXML, and ABC gets lengths with no notated value. Use a grid for an exact score.

**Use when:** exporting recognizer/analysis output (`mir-transcribe`, `mir-drums`) or a parsed MIDI file to a score a musician can read in MuseScore/Finale/Sibelius, or to a lightweight ABC string for the web. Not a full engraving engine — no beaming, no lyrics, no multi-staff systems beyond one piano grand staff.

---

Part of [@audio/midi](https://github.com/audiojs/midi) — the midi family umbrella.

MIT © [audiojs](https://github.com/audiojs)
