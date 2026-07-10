# @audio/midi-parse

> Standard MIDI file parser — tracks, tempo map, note events

SMF 0/1 reader: header, tracks, running status, variable-length deltas, tempo map (all
set-tempo events applied across tracks), and a flattened note list with absolute seconds.

```js
import parse from '@audio/midi-parse'

let { tracks, tempos, notes, duration } = parse(smfBytes)
```

`parse(buf: ArrayBuffer|Uint8Array) → { format, division, tracks, tempos, notes, duration }`

Each note: `{ time, duration, midi, velocity, channel, track }` — `time`/`duration` in
seconds, `velocity` normalized 0..1. `tempos`: `[{ tick, time, usPerBeat }]`.

## Install

```
npm i @audio/midi-parse
```
