/** Raw SMF track event — meta/sysex/channel payloads vary by `type`. */
export interface MidiEvent {
  tick: number
  time: number
  type: string
  channel?: number
  [key: string]: unknown
}

export interface Tempo {
  tick: number
  time: number
  usPerBeat: number
}

export interface Note {
  /** seconds */
  time: number
  /** seconds */
  duration: number
  midi: number
  /** normalized 0..1 */
  velocity: number
  channel: number
  track: number
}

export interface ParseResult {
  format: number
  division: number
  tracks: MidiEvent[][]
  tempos: Tempo[]
  notes: Note[]
  /** seconds — end time of the last note */
  duration: number
}

/** Parse a Standard MIDI File (SMF 0/1). */
export default function parse(buf: ArrayBuffer | Uint8Array): ParseResult
