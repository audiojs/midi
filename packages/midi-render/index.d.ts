/** Family generator contract: every pitched @audio/synth-* generator satisfies this. */
export type Voice = (freq: number, opts: { fs: number, duration: number, velocity: number, [key: string]: unknown }) => Float32Array

export interface GmProgram {
  /** GM1 program name, e.g. 'Acoustic Grand Piano' */
  name: string
  /** GM1 instrument family, e.g. 'Piano' */
  family: string
  voice: Voice
}

export interface GmPercussionKey {
  /** GM1 percussion key name, e.g. 'Acoustic Bass Drum' */
  name: string
  voice: Voice
}

export interface GmMap {
  /** 128 entries, index = GM program number 0-127 */
  programs: GmProgram[]
  /** GM1 percussion key map, keys 35-81 (channel 10) */
  percussion: Record<number, GmPercussionKey>
}

/** General MIDI Level 1 program/percussion map — the built-in synth-GM mapping. */
export const GM: GmMap

/** Look up the built-in synth voice for a GM program number (0-127). Throws on an
 *  out-of-range or non-integer program. */
export function voiceFor(program: number): Voice

export interface RenderOptions {
  /** sample rate, default 44100 */
  fs?: number
  /** output channel count, default 2 */
  channels?: 1 | 2
  /** max simultaneous notes per (channel, program) or (channel, drum key) group — oldest is
   *  stolen with a 5ms fade, default 32 */
  voices?: number
  /** seconds of silence appended after the render's natural end, default 1.0 */
  tail?: number
  /** overall gain multiplier applied before normalization, default 0.5 */
  gain?: number
  /** peak-normalize to -1 dBFS if the mix exceeds it; never boosts a quieter mix, default true */
  normalize?: boolean
  /** override the GM program map for specific program numbers */
  programs?: Record<number, Voice>
  /** override the GM percussion map for specific key numbers */
  drums?: Record<number, Voice>
  /** stretches/compresses the whole schedule (2 = twice as fast), default 1 */
  tempoScale?: number
  /** semitones added to every non-percussion note, default 0 */
  transpose?: number
  /** pitch-bend sensitivity in semitones (GM default RPN 0,0 = 2); custom RPN messages
   *  are not parsed, default 2 */
  bendRange?: number
}

export interface RenderResult {
  /** one Float32Array per output channel, [-1, 1] */
  channelData: Float32Array[]
  sampleRate: number
  /** seconds */
  duration: number
  /** number of notes rendered */
  notes: number
}

/**
 * Render a Standard MIDI File to PCM using General MIDI Level 1 synthesis — no soundfont,
 * no sample assets.
 * @param midi — SMF bytes, or an already-parsed @audio/midi-parse result
 */
export default function render(midi: Uint8Array | ArrayBuffer | object, opts?: RenderOptions): RenderResult
