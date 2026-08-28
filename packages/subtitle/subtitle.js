// Timed-text subtitle formats — parse + write, zero deps.
//   SRT    de facto SubRip format (no formal spec)
//   WebVTT W3C — https://www.w3.org/TR/webvtt1/
//   LRC    de facto lyrics format; enhanced word-timing is the A2/MiniLyrics extension
//          — https://en.wikipedia.org/wiki/LRC_(file_format)
//   TTML   W3C Timed Text Markup Language 2 — https://www.w3.org/TR/ttml2/
//          (minimal profile: <tt><body><div><p begin end>text<br/><span begin end>word</span></p>)

export const formats = ['srt', 'vtt', 'lrc', 'ttml']

// ── time: format (round once to the target unit, then decompose — avoids double-rounding) ──

function fmtClock(t, sep) {
	let ms = Math.max(0, Math.round(t * 1000))
	let h = Math.floor(ms / 3600000)
	let m = Math.floor(ms % 3600000 / 60000)
	let s = Math.floor(ms % 60000 / 1000)
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`
}
const fmtSrtTime = t => fmtClock(t, ',')
const fmtVttTime = t => fmtClock(t, '.')
const fmtTtmlTime = t => fmtClock(t, '.')

function fmtLrcTime(t, precision = 2) {
	let unit = precision === 3 ? 1000 : 100
	let total = Math.round(Math.max(0, t) * unit)
	let sec = Math.floor(total / unit)
	let frac = total % unit
	let m = Math.floor(sec / 60), s = sec % 60
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frac).padStart(precision, '0')}`
}

// ── time: parse ──

// [h+:]mm:ss[.,frac] — hours optional (VTT/SRT), fraction optional (TTML bare clock-time)
function parseHms(str) {
	let m = /^(?:(\d+):)?(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(str.trim())
	if (!m) return null
	let [, h, mi, s, frac] = m
	return (h ? +h * 3600 : 0) + +mi * 60 + +s + (frac ? Number('0.' + frac) : 0)
}

function parseLrcTime(str) {
	let m = /^(\d{1,4}):(\d{2})(?:[.:](\d{1,3}))?$/.exec(str.trim())
	if (!m) return null
	let [, mi, s, frac] = m
	return +mi * 60 + +s + (frac ? Number('0.' + frac) : 0)
}

function parseTtmlTime(str, frameRate) {
	str = str.trim()
	let fm = /^(\d+):(\d{2}):(\d{2}):(\d+)$/.exec(str)
	if (fm) {
		if (!frameRate) throw new Error(`subtitle: TTML — frame timecode "${str}" needs ttp:frameRate`)
		return +fm[1] * 3600 + +fm[2] * 60 + +fm[3] + +fm[4] / frameRate
	}
	let hms = parseHms(str)
	if (hms != null) return hms
	let om = /^(\d+(?:\.\d+)?)(ms|h|m|s|f)$/.exec(str)
	if (om) {
		let n = +om[1]
		if (om[2] === 'h') return n * 3600
		if (om[2] === 'm') return n * 60
		if (om[2] === 's') return n
		if (om[2] === 'ms') return n / 1000
		if (!frameRate) throw new Error(`subtitle: TTML — frame offset "${str}" needs ttp:frameRate`)
		return n / frameRate
	}
	throw new Error(`subtitle: TTML — unrecognized time expression "${str}"`)
}

// ── text: normalize, XML escape/unescape, strip inline markup ──

const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

const xesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xescAttr = s => xesc(s).replace(/"/g, '&quot;')
const xunesc = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
	if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
	return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]
})

const TAG_RE = /<\/?[^>]+>/g
const stripTags = s => s.replace(TAG_RE, '')

// split cue text on inline `<mm:ss.mmm>`/`<hh:mm:ss.mmm>` timestamp tags into per-word
// spans (VTT karaoke tags, enhanced-LRC word tags share this shape); parseTime maps a
// captured tag body to seconds.
function splitInlineTimestamps(raw, parseTime, start, end) {
	let parts = raw.split(/<((?:\d+:)?\d{1,4}:\d{2}[.,:]\d{1,3})>/)
	if (parts.length === 1) return { text: stripTags(raw) }
	let words = []
	let first = stripTags(parts[0]).trim()
	if (first) words.push({ start, text: first })
	for (let i = 1; i < parts.length; i += 2) {
		let t = parseTime(parts[i])
		if (words.length) words[words.length - 1].end = t
		let seg = stripTags(parts[i + 1] ?? '').trim()
		if (seg) words.push({ start: t, text: seg })
	}
	if (words.length) words[words.length - 1].end = end
	return { text: words.map(w => w.text).join(' '), words }
}

// ── SRT — de facto SubRip: "n\nHH:MM:SS,mmm --> HH:MM:SS,mmm\ntext\n\n" ──

function parseSrt(text) {
	let lines = text.split('\n')
	let cues = []
	let i = 0
	while (i < lines.length) {
		while (i < lines.length && !lines[i].trim()) i++
		if (i >= lines.length) break
		let id
		if (/^\d+$/.test(lines[i].trim())) { id = lines[i].trim(); i++ }
		if (i >= lines.length) throw new Error(`subtitle: SRT — expected timing line at line ${i + 1}`)
		let m = /^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)/.exec(lines[i])
		if (!m) throw new Error(`subtitle: SRT — bad timestamp at line ${i + 1}: "${lines[i]}"`)
		let start = parseHms(m[1]), end = parseHms(m[2])
		i++
		let textLines = []
		while (i < lines.length && lines[i].trim() !== '') { textLines.push(lines[i]); i++ }
		cues.push({ start, end, text: textLines.join('\n'), ...(id ? { id } : {}) })
	}
	return { cues, format: 'srt' }
}

function writeSrt(cues) {
	if (!cues.length) return ''
	return cues.map((c, i) => `${c.id ?? i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}`).join('\n\n') + '\n\n'
}

// ── WebVTT — W3C: "WEBVTT\n\n[id\n]HH:MM:SS.mmm --> HH:MM:SS.mmm [settings]\ntext\n\n" ──

function parseVtt(text) {
	let lines = text.split('\n')
	if (!/^WEBVTT/.test(lines[0] ?? '')) throw new Error('subtitle: VTT — missing WEBVTT header')
	let header = lines[0].slice(6).replace(/^[\s-]+/, '').trim()
	let meta = header ? { header } : undefined
	let cues = []
	let i = 1
	while (i < lines.length) {
		while (i < lines.length && !lines[i].trim()) i++
		if (i >= lines.length) break
		let first = lines[i].trim()
		if (/^NOTE(\s|$)/.test(first) || /^(STYLE|REGION)\s*$/.test(first)) {
			i++
			while (i < lines.length && lines[i].trim() !== '') i++
			continue
		}
		let id
		let tm = /^((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*(.*)$/.exec(lines[i])
		if (!tm) {
			id = first
			i++
			if (i >= lines.length) throw new Error(`subtitle: VTT — expected timing line at line ${i + 1}`)
			tm = /^((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s*(.*)$/.exec(lines[i])
			if (!tm) throw new Error(`subtitle: VTT — bad timestamp at line ${i + 1}: "${lines[i]}"`)
		}
		let start = parseHms(tm[1]), end = parseHms(tm[2])
		let settings = tm[3].trim() || undefined
		i++
		let textLines = []
		while (i < lines.length && lines[i].trim() !== '') { textLines.push(lines[i]); i++ }
		let { text, words } = splitInlineTimestamps(textLines.join('\n'), s => parseHms(s.replace(',', '.')), start, end)
		cues.push({ start, end, text, ...(id ? { id } : {}), ...(settings ? { settings } : {}), ...(words ? { words } : {}) })
	}
	return { cues, format: 'vtt', ...(meta ? { meta } : {}) }
}

function writeVtt(cues, meta, opts) {
	let header = 'WEBVTT' + (meta?.header ? ' - ' + meta.header : '')
	if (!cues.length) return header + '\n\n'
	let blocks = cues.map(c => {
		let lines = []
		if (c.id != null) lines.push(String(c.id))
		lines.push(`${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}` + (c.settings ? ' ' + c.settings : ''))
		lines.push(opts.words && c.words?.length
			? c.words.map((w, i) => (i === 0 ? '' : ` <${fmtVttTime(w.start)}>`) + w.text).join('')
			: c.text)
		return lines.join('\n')
	})
	return header + '\n\n' + blocks.join('\n\n') + '\n'
}

// ── LRC — de facto lyrics format: "[tag:value]" header + "[mm:ss.xx]text" lines;
//    multiple leading timestamps repeat a line; enhanced word tags: "<mm:ss.xx>word" ──

function parseLrc(text) {
	let lines = text.split('\n')
	let meta = {}
	let raw = []
	for (let line of lines) {
		let m = /^(\[[^\]]*\])+/.exec(line)
		if (!m) continue
		let rest = line.slice(m[0].length)
		let times = []
		for (let tag of m[0].match(/\[[^\]]*\]/g)) {
			let body = tag.slice(1, -1)
			let t = parseLrcTime(body)
			if (t != null) times.push(t)
			else {
				let ci = body.indexOf(':')
				if (ci > 0) meta[body.slice(0, ci)] = body.slice(ci + 1)
			}
		}
		for (let t of times) raw.push({ start: t, text: rest })
	}
	// offset: "+" plays lyrics sooner, i.e. subtract from the raw tag time (LRC spec)
	let offsetSec = meta.offset != null ? parseFloat(meta.offset) / 1000 : 0
	let defaultEnd = meta.length != null ? parseLrcTime(meta.length) : null
	raw.sort((a, b) => a.start - b.start)
	let cues = raw.map((e, i) => {
		let start = e.start - offsetSec
		let end = i + 1 < raw.length ? raw[i + 1].start - offsetSec : (defaultEnd != null ? Math.max(start, defaultEnd - offsetSec) : start + 5)
		let { text, words } = splitInlineTimestamps(e.text, s => parseLrcTime(s) - offsetSec, start, end)
		return { start, end, text, ...(words ? { words } : {}) }
	})
	return { cues, format: 'lrc', ...(Object.keys(meta).length ? { meta } : {}) }
}

function writeLrc(cues, meta, opts) {
	let precision = opts.precision === 3 ? 3 : 2
	let offsetSec = meta?.offset != null ? parseFloat(meta.offset) / 1000 : 0
	let lines = []
	for (let k in meta || {}) lines.push(`[${k}:${meta[k]}]`)
	for (let c of cues) {
		let text = opts.words && c.words?.length
			? c.words.map(w => `<${fmtLrcTime(w.start + offsetSec, precision)}>${w.text}`).join(' ')
			: c.text
		lines.push(`[${fmtLrcTime(c.start + offsetSec, precision)}]${text}`)
	}
	return lines.length ? lines.join('\n') + '\n' : ''
}

// ── TTML — W3C minimal profile: hand-rolled tag/text walker (no DOM, zero deps) ──

const localName = name => name.slice(name.indexOf(':') + 1)

function parseAttrs(tagBody) {
	let attrs = {}
	let re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g
	let m
	while ((m = re.exec(tagBody))) attrs[m[1] ?? m[3]] = xunesc(m[2] ?? m[4])
	return attrs
}

function tokenizeXml(xml) {
	let out = []
	let re = /<!--[\s\S]*?-->|<([^>]+)>|([^<]+)/g
	let m
	while ((m = re.exec(xml))) {
		if (m[1] != null) out.push({ tag: m[1] })
		else if (m[2] != null) out.push({ text: xunesc(m[2]) })
	}
	return out
}

// recursive-descent over the flat token list; returns sibling nodes up to (and consuming)
// a closing tag matching `stopName`, or end of input at the document root (stopName=null)
function parseNodes(tokens, pos, stopName) {
	let nodes = []
	while (pos < tokens.length) {
		let tok = tokens[pos]
		if (tok.text != null) { nodes.push({ type: 'text', text: tok.text }); pos++; continue }
		let raw = tok.tag
		if (raw[0] === '?' || raw[0] === '!') { pos++; continue } // <?xml ...?>, <!DOCTYPE ...>
		if (raw[0] === '/') {
			pos++
			if (localName(raw.slice(1).trim()) === stopName) return { nodes, pos }
			continue
		}
		let selfClose = raw.trim().endsWith('/')
		let body = selfClose ? raw.trim().slice(0, -1) : raw
		let name = localName(/^([\w:.-]+)/.exec(body.trim())[1])
		let attrs = parseAttrs(body)
		pos++
		if (selfClose) { nodes.push({ type: 'elem', name, attrs, children: [] }); continue }
		let sub = parseNodes(tokens, pos, name)
		nodes.push({ type: 'elem', name, attrs, children: sub.nodes })
		pos = sub.pos
	}
	return { nodes, pos }
}

function findFirst(nodes, name) {
	for (let n of nodes) {
		if (n.type !== 'elem') continue
		if (n.name === name) return n
		let f = findFirst(n.children, name)
		if (f) return f
	}
	return null
}

function findAll(nodes, name, out = []) {
	for (let n of nodes) {
		if (n.type !== 'elem') continue
		if (n.name === name) out.push(n)
		findAll(n.children, name, out)
	}
	return out
}

function textContent(nodes) {
	let out = ''
	for (let n of nodes) {
		if (n.type === 'text') out += n.text
		else if (n.name === 'br') out += '\n'
		else out += textContent(n.children)
	}
	return out
}

// <p> content -> plain text (br -> \n) + word timings from nested <span begin end>
function ttmlCueContent(children, frameRate) {
	let parts = []
	let words = null
	const walk = nodes => {
		for (let n of nodes) {
			if (n.type === 'text') parts.push(n.text)
			else if (n.name === 'br') parts.push('\n')
			else if (n.name === 'span' && n.attrs.begin != null) {
				let start = parseTtmlTime(n.attrs.begin, frameRate)
				let end = n.attrs.end != null ? parseTtmlTime(n.attrs.end, frameRate) : undefined
				let wtext = textContent(n.children)
				words = words || []
				words.push({ start, ...(end != null ? { end } : {}), text: wtext })
				parts.push(wtext)
			} else walk(n.children)
		}
	}
	walk(children)
	return { text: parts.join('').trim(), words: words || undefined }
}

function parseTtml(text) {
	let { nodes } = parseNodes(tokenizeXml(text), 0, null)
	let tt = findFirst(nodes, 'tt')
	if (!tt) throw new Error('subtitle: TTML — missing <tt> root element')
	let frameRate = tt.attrs['ttp:frameRate'] ? parseFloat(tt.attrs['ttp:frameRate']) : undefined
	if (frameRate && tt.attrs['ttp:frameRateMultiplier']) {
		let [n, d] = tt.attrs['ttp:frameRateMultiplier'].trim().split(/\s+/).map(Number)
		if (n && d) frameRate = frameRate * n / d
	}
	let cues = findAll(tt.children, 'p').map(p => {
		let begin = p.attrs.begin != null ? parseTtmlTime(p.attrs.begin, frameRate) : 0
		let end = p.attrs.end != null ? parseTtmlTime(p.attrs.end, frameRate)
			: p.attrs.dur != null ? begin + parseTtmlTime(p.attrs.dur, frameRate) : undefined
		let { text, words } = ttmlCueContent(p.children, frameRate)
		let style = {}
		for (let k in p.attrs) if (k.startsWith('tts:')) style[k.slice(4)] = p.attrs[k]
		let id = p.attrs['xml:id']
		return { start: begin, end, text, ...(id ? { id } : {}), ...(words ? { words } : {}), ...(Object.keys(style).length ? { style } : {}) }
	})
	for (let i = cues.length - 1; i >= 0; i--)
		if (cues[i].end == null) cues[i].end = i + 1 < cues.length ? cues[i + 1].start : cues[i].start + 5

	let meta = {}
	if (tt.attrs['xml:lang']) meta.lang = tt.attrs['xml:lang']
	let head = findFirst(tt.children, 'head')
	if (head) for (let k of ['title', 'desc', 'copyright']) {
		let el = findFirst(head.children, k)
		if (el) meta[k] = textContent(el.children).trim()
	}
	return { cues, format: 'ttml', ...(Object.keys(meta).length ? { meta } : {}) }
}

function writeTtml(cues, meta, opts) {
	let head = ''
	if (meta && (meta.title || meta.desc || meta.copyright)) {
		let m = []
		if (meta.title) m.push(`      <ttm:title>${xesc(meta.title)}</ttm:title>`)
		if (meta.desc) m.push(`      <ttm:desc>${xesc(meta.desc)}</ttm:desc>`)
		if (meta.copyright) m.push(`      <ttm:copyright>${xesc(meta.copyright)}</ttm:copyright>`)
		head = `  <head>\n    <metadata xmlns:ttm="http://www.w3.org/ns/ttml#metadata">\n${m.join('\n')}\n    </metadata>\n  </head>\n`
	}
	let ps = cues.map(c => {
		let text = opts.words && c.words?.length
			? c.words.map(w => `<span begin="${fmtTtmlTime(w.start)}"${w.end != null ? ` end="${fmtTtmlTime(w.end)}"` : ''}>${xesc(w.text)}</span>`).join(' ')
			: c.text.split('\n').map(xesc).join('<br/>')
		let attrs = ` begin="${fmtTtmlTime(c.start)}" end="${fmtTtmlTime(c.end)}"`
		if (c.id != null) attrs += ` xml:id="${xescAttr(String(c.id))}"`
		if (c.style) for (let k in c.style) attrs += ` tts:${k}="${xescAttr(c.style[k])}"`
		return `      <p${attrs}>${text}</p>`
	})
	let langAttr = meta?.lang ? ` xml:lang="${xescAttr(meta.lang)}"` : ''
	return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml"${langAttr}>\n${head}  <body>\n    <div>\n${ps.join('\n')}\n    </div>\n  </body>\n</tt>\n`
}

// ── format detection + public parse/write ──

function detectFormat(t) {
	if (/^WEBVTT/.test(t)) return 'vtt'
	if (/^\s*<\?xml|^\s*<[\w-]*:?tt[\s>]/.test(t)) return 'ttml'
	if (/^\s*\[(?:[a-zA-Z#][\w#]*:|\d{1,4}:\d{2})/.test(t)) return 'lrc'
	return 'srt'
}

/** Parse SRT/WebVTT/LRC/TTML text into `{ cues, meta?, format }`. Format is auto-detected when omitted. */
export function parse(text, format) {
	if (typeof text !== 'string') throw new TypeError('subtitle: parse expects a string')
	let t = normalize(text)
	format = format || detectFormat(t)
	if (!formats.includes(format)) throw new Error(`subtitle: unknown format "${format}"`)
	if (!t.trim()) return { cues: [], format }
	if (format === 'srt') return parseSrt(t)
	if (format === 'vtt') return parseVtt(t)
	if (format === 'lrc') return parseLrc(t)
	return parseTtml(t)
}

/** Serialize cues (a `{cues,meta,format}` object or a bare `Cue[]`) to SRT/WebVTT/LRC/TTML text. */
export function write(subs, format, opts = {}) {
	if (!formats.includes(format)) throw new Error(`subtitle: unknown format "${format}"`)
	let cues = Array.isArray(subs) ? subs : subs.cues
	let meta = Array.isArray(subs) ? undefined : subs.meta
	if (format === 'srt') return writeSrt(cues)
	if (format === 'vtt') return writeVtt(cues, meta, opts)
	if (format === 'lrc') return writeLrc(cues, meta, opts)
	return writeTtml(cues, meta, opts)
}

// ── time transforms ──

const getCues = subs => Array.isArray(subs) ? subs : subs.cues
const wrapLike = (subs, cues) => Array.isArray(subs) ? cues : { ...subs, cues }
const shiftWord = (w, fn) => ({ ...w, start: fn(w.start), ...(w.end != null ? { end: fn(w.end) } : {}) })
const mapCue = (c, fn) => ({ ...c, start: fn(c.start), end: fn(c.end), ...(c.words ? { words: c.words.map(w => shiftWord(w, fn)) } : {}) })

/** Shift every cue (and word) start/end by `seconds` (may be negative). */
export function shift(subs, seconds) {
	return wrapLike(subs, getCues(subs).map(c => mapCue(c, t => t + seconds)))
}

/** Scale every cue (and word) time by `factor` (e.g. a tempo change). */
export function scale(subs, factor) {
	return wrapLike(subs, getCues(subs).map(c => mapCue(c, t => t * factor)))
}

/**
 * Remap cue times through a piecewise-linear input->output time map, e.g. the breakpoints
 * a desilence pass returns. Cues that fall entirely inside a removed span (a map segment
 * whose `to` does not advance) are dropped; the rest are linearly interpolated.
 */
export function project(subs, map) {
	let pts = [...map].sort((a, b) => a.from - b.from)
	if (!pts.length) return wrapLike(subs, getCues(subs).slice())
	const warp = t => {
		if (t <= pts[0].from) return pts[0].to
		for (let i = 1; i < pts.length; i++) {
			if (t <= pts[i].from) {
				let a = pts[i - 1], b = pts[i]
				return b.from === a.from ? a.to : a.to + (t - a.from) / (b.from - a.from) * (b.to - a.to)
			}
		}
		let last = pts[pts.length - 1]
		return last.to + (t - last.from)
	}
	const removed = (start, end) => pts.some((a, i) => {
		let b = pts[i + 1]
		return b && b.to === a.to && b.from > a.from && start >= a.from && end <= b.from
	})
	let cues = getCues(subs).filter(c => !removed(c.start, c.end)).map(c => mapCue(c, warp))
	return wrapLike(subs, cues)
}

// ── fromWords: segment ASR/aligner word timings into readable cues (Netflix-style limits) ──

function wrapText(text, maxChars, maxLines) {
	let out = [], cur = ''
	for (let w of text.split(' ')) {
		let next = cur ? cur + ' ' + w : w
		if (next.length > maxChars && cur) { out.push(cur); cur = w }
		else cur = next
	}
	if (cur) out.push(cur)
	if (out.length > maxLines) out = [...out.slice(0, maxLines - 1), out.slice(maxLines - 1).join(' ')]
	return out.join('\n')
}

/** Segment word-level timings (ASR/aligner output) into readable cues. */
export function fromWords(words, opts = {}) {
	let { maxChars = 42, maxDuration = 6, maxGap = 1.0, lines = 2 } = opts
	let maxTotal = maxChars * lines
	let items = words.map((w, i) => {
		let text = w.text ?? w.word
		if (text == null) throw new Error(`subtitle: fromWords — item ${i} missing text/word`)
		if (w.start == null || w.end == null || w.end < w.start) throw new Error(`subtitle: fromWords — item ${i} has invalid start/end`)
		return { text, start: w.start, end: w.end }
	})
	let cues = [], buf = [], lastBreak = -1
	const build = seg => ({
		start: seg[0].start, end: seg[seg.length - 1].end,
		text: wrapText(seg.map(w => w.text).join(' '), maxChars, lines),
		words: seg.map(w => ({ start: w.start, end: w.end, text: w.text })),
	})
	const flush = at => { cues.push(build(buf.slice(0, at + 1))); buf = buf.slice(at + 1); lastBreak = -1 }
	for (let w of items) {
		if (buf.length) {
			let prev = buf[buf.length - 1]
			let gap = w.start - prev.end
			let candLen = buf.map(x => x.text).concat(w.text).join(' ').length
			let candDur = w.end - buf[0].start
			if (gap >= maxGap || candLen > maxTotal || candDur > maxDuration)
				flush(lastBreak >= 0 && lastBreak < buf.length - 1 ? lastBreak : buf.length - 1)
		}
		buf.push(w)
		if (/[.!?,;:]$/.test(w.text)) lastBreak = buf.length - 1
	}
	if (buf.length) flush(buf.length - 1)
	return cues
}
