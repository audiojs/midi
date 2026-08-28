/** A single word/token timestamp — enhanced LRC `<mm:ss.xx>`, VTT inline `<00:00:01.000>`, TTML `<span begin end>`. */
export interface Word {
  /** seconds */
  start: number
  /** seconds — omitted when the format gives only a start point (VTT/LRC inline tags) */
  end?: number
  text: string
}

export interface Cue {
  /** seconds */
  start: number
  /** seconds */
  end: number
  /** plain text, line breaks as \n; markup (VTT `<b>`/`<i>`/`<c.x>`/`<v>`, TTML `<span>` wrappers) stripped */
  text: string
  /** SRT sequence number / VTT cue identifier / TTML xml:id, as a string */
  id?: string
  /** word-level timestamps, when the source format carries them */
  words?: Word[]
  /** VTT cue settings line, raw (e.g. "position:10%,line-left align:left") */
  settings?: string
  /** inline style, e.g. TTML tts:* attributes on the <p> with the tts: prefix stripped */
  style?: Record<string, string>
}

/**
 * ti/ar/al/by/offset/length — LRC tags (offset in ms, sign per spec: "+" plays sooner).
 * VTT: header text after "WEBVTT". TTML: xml:lang, ttm:title/desc/copyright.
 */
export type Meta = Record<string, string>

export interface Subtitles {
  cues: Cue[]
  meta?: Meta
  format: 'srt' | 'vtt' | 'lrc' | 'ttml'
}

export interface WriteOptions {
  /** VTT/LRC/TTML: emit word-level timestamps (cue.words) inline instead of plain text */
  words?: boolean
  /** LRC timestamp fraction digits: 2 = centiseconds (default, standard), 3 = milliseconds */
  precision?: 2 | 3
}

export interface FromWordsOptions {
  /** max characters per line, default 42 (Netflix Timed Text Style Guide) */
  maxChars?: number
  /** max cue duration, seconds, default 6 */
  maxDuration?: number
  /** silence between words that forces a cue break, seconds, default 1.0 */
  maxGap?: number
  /** max lines per cue, default 2 */
  lines?: number
}

export interface WordInput {
  text?: string
  /** alternate key some aligners use instead of `text` */
  word?: string
  start: number
  end: number
}

/** One input→output time breakpoint (the shape @audio/denoise-desilence returns). */
export interface TimeMapPoint {
  from: number
  to: number
}

export const formats: readonly ['srt', 'vtt', 'lrc', 'ttml']

/** Parse SRT/WebVTT/LRC/TTML text into cues. Format is auto-detected when omitted. */
export function parse(text: string, format?: Subtitles['format']): Subtitles

/** Serialize cues (a Subtitles object or a bare Cue[]) to SRT/WebVTT/LRC/TTML text. */
export function write(subs: Subtitles | Cue[], format: Subtitles['format'], opts?: WriteOptions): string

/** Shift every cue (and word) start/end by `seconds` (may be negative). */
export function shift<T extends Subtitles | Cue[]>(subs: T, seconds: number): T

/** Scale every cue (and word) time by `factor` (e.g. tempo change). */
export function scale<T extends Subtitles | Cue[]>(subs: T, factor: number): T

/**
 * Remap cue times through a piecewise-linear input→output time map (e.g. after silence
 * removal). Cues that fall entirely inside a removed span (a map segment whose `to` does
 * not advance) are dropped; others are linearly interpolated.
 */
export function project<T extends Subtitles | Cue[]>(subs: T, map: TimeMapPoint[]): T

/** Segment word-level timings (ASR/aligner output) into readable cues. */
export function fromWords(words: WordInput[], opts?: FromWordsOptions): Cue[]
