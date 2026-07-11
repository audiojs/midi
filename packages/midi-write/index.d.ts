export interface WriteNote {
  /** seconds */
  time: number
  /** seconds, default 0.5 */
  duration?: number
  midi: number
  /** normalized 0..1, default 0.8 */
  velocity?: number
  /** default 0 */
  channel?: number
}

export interface WriteOptions {
  /** default 120 */
  bpm?: number
  /** ticks per beat, default 480 */
  division?: number
}

/** Write note events to a Standard MIDI File (format 0). */
export default function write(notes: WriteNote[], options?: WriteOptions): Uint8Array
