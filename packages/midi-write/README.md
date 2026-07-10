# @audio/midi-write

> Standard MIDI file writer — note events → SMF (mir-transcribe output target)

Writes SMF format-0: note events → tempo + note on/off pairs, sorted and delta-encoded.

```js
import write from '@audio/midi-write'

let smf = write(notes, { bpm: 120 })   // Uint8Array
```

`write(notes: Array<{time, duration, midi, velocity=0.8, channel=0}>, opts: {bpm=120, division=480}) → Uint8Array`

`time`/`duration` in seconds, `velocity` normalized 0..1.

## Install

```
npm i @audio/midi-write
```
