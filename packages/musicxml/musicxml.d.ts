/** Input note event — seconds. Matches @audio/midi-write, mir-transcribe's NoteEvent, and
 *  mir-drums' DrumEvent (via `type`). */
export interface InputNote {
	/** onset, seconds */
	time: number
	/** seconds */
	duration: number
	/** MIDI note number (omit for percussion notes identified by `type`) */
	midi?: number
	/** normalized 0..1, default 0.8 */
	velocity?: number
	/** 0-based, default 0 — carried through quantize(); voices follow overlap, not channel */
	channel?: number
	/** mir-drums percussion type, used when `midi` is absent on a percussion part */
	type?: 'kick' | 'snare' | 'hihat' | string
}

export interface InstrumentInfo {
	name?: string
	/** 0-based MIDI channel (converted to MusicXML's 1-based midi-channel) */
	channel?: number
	/** 0-based MIDI program (converted to MusicXML's 1-based midi-program) */
	program?: number
}

export interface PartInput {
	name?: string
	notes: InputNote[]
	instrument?: InstrumentInfo
	/** GM channel-10 drum part — notes read via `type` or a raw channel-10 `midi` number */
	percussion?: boolean
	/** default: auto by median pitch (≥60 treble, else bass) */
	clef?: 'treble' | 'bass' | 'grand' | 'percussion'
}

export type WriteInput = InputNote[] | { parts: PartInput[] }

export interface TempoPoint {
	/** seconds */
	time: number
	bpm: number
}

export interface WriteOptions {
	/** default 120 — ignored when `tempos` is given */
	bpm?: number
	/** piecewise tempo map; overrides `bpm` */
	tempos?: TempoPoint[]
	/** [beats, beat-type], default [4, 4] */
	timeSignature?: [number, number]
	/** circle-of-fifths position (−7..7) or a key name ('C', 'G', 'Fm', 'Am', …). Default 0 (C major) */
	key?: number | string
	/** default 'major' — ignored when `key` is a name string that already encodes mode (e.g. 'Am') */
	mode?: 'major' | 'minor'
	/** ticks per quarter note, default 480 (bumped up as needed so every duration is exact) */
	divisions?: number
	/** rhythmic grid denominator: 4, 8, 16, 32, or 0 = no quantization. Default 16 */
	quantize?: number
	/** also try 1/8 and 1/16 triplet grids per note, default true */
	triplets?: boolean
	/** shortest kept note, in beats; default = one grid step */
	minDuration?: number
	title?: string
	composer?: string
	/** <identification><encoding><software>, default '@audio/musicxml' */
	software?: string
	/** shorten measure 1 to the remainder of the last measure (anacrusis), default false */
	pickup?: boolean
}

/**
 * Note events → MusicXML 4.0 (score-partwise); notes that overlap within a part are written as
 * separate voices. See README for the MusicXML 4.0 citation.
 */
export default function write(input: WriteInput, options?: WriteOptions): string

export interface OutputNote {
	/** seconds */
	time: number
	/** seconds */
	duration: number
	midi: number
	/** normalized 0..1 — MusicXML has no standard per-note velocity; always 0.8 on parse */
	velocity: number
	voice: number
}

export interface ParsedPart {
	name: string
	notes: OutputNote[]
	key: { fifths: number, mode: 'major' | 'minor' }
	/** [beats, beat-type] */
	timeSignature: [number, number]
	tempos: TempoPoint[]
	/** ticks per quarter note, as declared in the source file */
	divisions: number
}

export interface ParseResult {
	parts: ParsedPart[]
	title?: string
	composer?: string
}

/**
 * MusicXML 4.0 (score-partwise or score-timewise) → note events. Transposing-instrument
 * <transpose> is not un-transposed — pitches are read as literally written (see README).
 */
export function parse(xml: string): ParseResult

/**
 * Note events → one ABC 2.1 tune: every voice of every part is an ABC voice (V:1, V:2, …),
 * a part's voices on one staff (%%score). Same quantization options as `write`, plus
 * `title`/`composer`.
 */
export function toAbc(input: WriteInput, options?: WriteOptions): string

export interface QuantizeOptions {
	bpm?: number
	tempos?: TempoPoint[]
	/** binary grid denominator: 4, 8, 16, 32, or 0 = no quantization. Default 16 */
	grid?: number
	/** also try 1/8 and 1/16 triplet grids per note, default true */
	triplets?: boolean
	/** shortest kept duration, in beats; default = one grid step */
	minDuration?: number
}

export interface QuantizedNote {
	/** onset, in beats (1 beat = 1 quarter note) */
	beat: number
	/** duration, in beats */
	beats: number
	midi: number
	velocity: number
	channel: number
	voice?: number
	type?: string
	tuplet: { actual: number, normal: number, unit: 'eighth' | '16th' } | null
}

/**
 * Seconds → beat-grid quantization: snaps onsets/durations to the nearest grid point
 * (optionally the better-fitting triplet grid). Overlapping notes are kept whole.
 */
export function quantize(notes: InputNote[], options?: QuantizeOptions): QuantizedNote[]
