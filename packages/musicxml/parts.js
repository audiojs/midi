// Shared input normalization for write.js and abc.js.

/** flat notes array | { parts: [...] } → parts array */
export function normalizeParts (input) {
	if (Array.isArray(input)) return [{ name: 'Music', notes: input }]
	if (input && Array.isArray(input.parts)) return input.parts
	throw new TypeError('musicxml: expected an array of notes or { parts: [...] }')
}
