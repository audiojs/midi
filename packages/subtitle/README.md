# @audio/subtitle [![npm](https://img.shields.io/npm/v/@audio/subtitle)](https://www.npmjs.com/package/@audio/subtitle) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Timed-text subtitle formats — SRT, WebVTT, LRC, TTML: parse and write

```
npm install @audio/subtitle
```

```js
import { parse, write } from '@audio/subtitle'
```

Reads and writes four timed-text formats to one `{ cues, meta?, format }` shape: **SRT**
(de facto SubRip, no formal spec), **WebVTT** ([W3C](https://www.w3.org/TR/webvtt1/)),
**LRC** (de facto lyrics format; word-level timing is the A2/MiniLyrics
["enhanced"](https://en.wikipedia.org/wiki/LRC_(file_format)) extension), and **TTML**
([W3C Timed Text Markup Language 2](https://www.w3.org/TR/ttml2/), a minimal profile:
`<tt><body><div><p begin end>`). Format is auto-detected on parse. Zero dependencies —
TTML is walked with a small hand-rolled tag tokenizer, not a DOM parser.

```js
let subs = parse(srtText)                    // auto-detects 'srt'
subs.cues                                     // [{ start, end, text, id?, words?, ... }]

write(subs, 'vtt')                            // -> WebVTT text
write(subs.cues, 'lrc', { words: true })      // bare Cue[] also accepted; word-level tags
```

Every cue is `{ start, end, text, id?, words?, settings?, style? }` — `start`/`end` in
seconds, `text` plain with `\n` line breaks (VTT `<b>`/`<i>`/`<c.x>`/`<v>` and TTML
`<span>` wrappers are stripped, not retained). `words?: {start, end?, text}[]` carries
word-level timing when the source has it: VTT/LRC inline `<00:01.000>` tags (chained —
each word's end is the next word's start) and TTML nested `<span begin end>` (independent
per-word begin/end). `meta` carries format-specific header data: LRC `ti`/`ar`/`al`/`by`/
`offset`/`length` tags (pass-through, any key), VTT the text after `WEBVTT`, TTML
`xml:lang` and `ttm:title`/`desc`/`copyright`.

```js
import { shift, scale, project, fromWords } from '@audio/subtitle'

shift(subs, 1.5)              // +1.5s to every cue and word
scale(subs, 48000 / 44100)    // resample-class tempo change
project(subs, desilenceMap)   // desilence-style [{from,to}] warp; dropped-span cues removed
fromWords(alignerWords)       // ASR/aligner word timings -> readable cues
```

`shift`/`scale`/`project` accept either a `{cues,...}` object or a bare `Cue[]` and return
the same shape. `project(subs, map)` linearly interpolates cue (and word) times through a
piecewise `[{from,to}]` map — the shape [`@audio/denoise`](https://github.com/audiojs/denoise)'s
silence-removal pass returns — and drops any cue that falls entirely inside a map segment
whose `to` doesn't advance (a removed span).

`fromWords(words, opts?)` segments raw word timings (`{text|word, start, end}`, e.g. from
a forced aligner) into cues, following the
[Netflix Timed Text Style Guide](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements)
line-length convention: breaks first at a ≥`maxGap` silence or trailing punctuation, and
only falls back to a hard cut at `maxChars`/`maxDuration` when neither is available.

| Option | Default | |
|---|---|---|
| `maxChars` | `42` | max characters per line |
| `maxDuration` | `6` | max cue duration, seconds |
| `maxGap` | `1.0` | silence between words that forces a break, seconds |
| `lines` | `2` | max lines per cue |

Time formatting is deterministic: milliseconds round half-up, decomposed once from a
single rounded total (no double-rounding drift). SRT/VTT/TTML always write `hh:mm:ss` with
hours (VTT's spec allows omitting a zero hour; this always includes it — simpler and
unambiguous for players that are strict about the field count). LRC writes `mm:ss.xx`
(centiseconds; `opts.precision: 3` for milliseconds), minutes unbounded rather than rolling
into hours, matching the format's convention. LRC's `offset` tag is applied per the spec
("+" plays lyrics sooner, i.e. subtracted from the raw tag time) — `write` re-adds it, so
`parse(write(x))` round-trips through an `offset` tag without double-shifting.

TTML parsing accepts clock-time (`00:00:01.500`), frame notation (`00:00:01:12` with
`ttp:frameRate`), and offset-time (`1.5s`, `500ms`, `2m`, `25f`); writing always emits
plain clock-time. `write` never emits `xml:space` or wraps `<p>` content across lines —
keep cue text free of incidental whitespace if hand-editing TTML for round-tripping.

**Use when:** importing/exporting captions or lyrics around any of the other atoms — ASR
transcripts (`fromWords`), ffmpeg/media pipelines, or timeline edits that shift/desilence
audio and need the subtitle track to follow.

---

Part of [@audio/midi](https://github.com/audiojs/midi) — the midi family umbrella
(symbolic & timed formats: SMF, MusicXML, subtitles).

MIT © [audiojs](https://github.com/audiojs)
