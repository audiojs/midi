// Minimal dependency-free XML: element-tree builder + serializer + a small well-formedness
// parser. Not a general XML processor — just enough of the spec (elements, attributes,
// text, comments, CDATA, prolog/DOCTYPE skipping) to round-trip MusicXML.

/** Build an element node: el('pitch', {}, [el('step', {}, 'C')]) or el('step', {}, 'C'). */
export function el (tag, attrs = {}, children = []) {
	return { tag, attrs, children: Array.isArray(children) ? children : [], text: Array.isArray(children) ? '' : String(children) }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const escape = (s) => String(s).replace(/[&<>"']/g, c => ESC[c])

/** Serialize an element tree to indented XML text (2-space indent). */
export function serialize (root, { declaration = true, doctype } = {}) {
	let lines = []
	if (declaration) lines.push('<?xml version="1.0" encoding="UTF-8"?>')
	if (doctype) lines.push(doctype)
	write(root, 0)
	return lines.join('\n') + '\n'

	function write (node, depth) {
		let pad = '  '.repeat(depth)
		let attrs = Object.entries(node.attrs || {}).filter(([, v]) => v != null)
			.map(([k, v]) => ` ${k}="${escape(v)}"`).join('')
		let kids = node.children || []
		if (!kids.length && !node.text) { lines.push(`${pad}<${node.tag}${attrs}/>`); return }
		if (!kids.length) { lines.push(`${pad}<${node.tag}${attrs}>${escape(node.text)}</${node.tag}>`); return }
		lines.push(`${pad}<${node.tag}${attrs}>`)
		for (let c of kids) write(c, depth + 1)
		lines.push(`${pad}</${node.tag}>`)
	}
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function unescape (s) {
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
		if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
		return ENTITIES[e] ?? m
	})
}

/**
 * Parse XML text into an element tree: { tag, attrs, children, text }.
 * @param {string} str
 * @returns {{tag, attrs, children, text}}
 */
export function parse (str) {
	let pos = 0
	const len = str.length
	const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
	function skipWs () { while (pos < len && isWs(str[pos])) pos++ }
	function skipMisc () {
		while (true) {
			skipWs()
			if (str.startsWith('<?', pos)) pos = str.indexOf('?>', pos) + 2
			else if (str.startsWith('<!--', pos)) pos = str.indexOf('-->', pos) + 3
			else if (str.startsWith('<!DOCTYPE', pos)) {
				let depth = 0, i = pos
				while (i < len) { if (str[i] === '[') depth++; else if (str[i] === ']') depth--; else if (str[i] === '>' && depth <= 0) { i++; break }; i++ }
				pos = i
			}
			else break
		}
	}
	function readName () {
		let start = pos
		while (pos < len && !isWs(str[pos]) && str[pos] !== '/' && str[pos] !== '>' && str[pos] !== '=') pos++
		return str.slice(start, pos)
	}
	function parseElement () {
		if (str[pos] !== '<') throw new SyntaxError(`musicxml: expected "<" at offset ${pos}`)
		pos++
		let tag = readName()
		let attrs = {}
		while (true) {
			skipWs()
			if (str.startsWith('/>', pos)) { pos += 2; return { tag, attrs, children: [], text: '' } }
			if (str[pos] === '>') { pos++; break }
			if (pos >= len) throw new SyntaxError(`musicxml: unterminated tag <${tag}>`)
			let aname = readName()
			skipWs()
			if (str[pos] !== '=') throw new SyntaxError(`musicxml: malformed attribute on <${tag}>`)
			pos++; skipWs()
			let quote = str[pos]
			if (quote !== '"' && quote !== "'") throw new SyntaxError(`musicxml: unquoted attribute on <${tag}>`)
			pos++
			let end = str.indexOf(quote, pos)
			if (end < 0) throw new SyntaxError(`musicxml: unterminated attribute on <${tag}>`)
			attrs[aname] = unescape(str.slice(pos, end))
			pos = end + 1
		}
		let children = [], text = ''
		while (true) {
			if (pos >= len) throw new SyntaxError(`musicxml: unclosed element <${tag}>`)
			if (str.startsWith('<!--', pos)) { pos = str.indexOf('-->', pos) + 3; continue }
			if (str.startsWith('<![CDATA[', pos)) { let e = str.indexOf(']]>', pos); text += str.slice(pos + 9, e); pos = e + 3; continue }
			if (str.startsWith('</', pos)) {
				pos += 2
				let close = readName()
				if (close !== tag) throw new SyntaxError(`musicxml: mismatched close tag </${close}> for <${tag}>`)
				skipWs()
				if (str[pos] === '>') pos++
				break
			}
			if (str[pos] === '<') children.push(parseElement())
			else {
				let next = str.indexOf('<', pos)
				if (next < 0) next = len
				text += unescape(str.slice(pos, next))
				pos = next
			}
		}
		return { tag, attrs, children, text: text.trim() }
	}
	skipMisc()
	let root = parseElement()
	return root
}

// ── element-tree query helpers ──────────────────────────────────────────────
export const child = (node, tag) => node.children.find(c => c.tag === tag)
export const children = (node, tag) => node.children.filter(c => c.tag === tag)
export const text = (node, tag, fallback) => { let c = child(node, tag); return c ? c.text : fallback }
export const num = (node, tag, fallback) => { let t = text(node, tag); return t != null ? Number(t) : fallback }
