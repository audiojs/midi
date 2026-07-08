// Standard MIDI file parser — SMF 0/1: header, tracks, running status, variable-length
// deltas, tempo map (all set-tempo events applied across tracks), and a flattened
// note list with absolute seconds. Meta and channel events preserved raw per track.

/**
 * @param {ArrayBuffer|Uint8Array} buf — SMF bytes
 * @returns {{
 *   format, division, tracks: Array<Array<event>>,
 *   tempos: Array<{tick, time, usPerBeat}>,
 *   notes: Array<{time, duration, midi, velocity, channel, track}>,
 *   duration
 * }} — event = { tick, time, type, ...payload }
 */
export default function parse (buf) {
	let b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
	let pos = 0
	const u32 = () => (b[pos++] << 24 | b[pos++] << 16 | b[pos++] << 8 | b[pos++]) >>> 0
	const u16 = () => b[pos++] << 8 | b[pos++]
	const vlq = () => {
		let v = 0, c
		do { c = b[pos++]; v = (v << 7) | (c & 0x7f) } while (c & 0x80)
		return v
	}
	const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[pos++]); return s }

	if (str(4) !== 'MThd') throw new RangeError('midi: not an SMF file (missing MThd)')
	let hlen = u32()
	let format = u16()
	let nTracks = u16()
	let division = u16()
	if (division & 0x8000) throw new RangeError('midi: SMPTE division not supported')
	pos += hlen - 6

	let tracks = []
	for (let t = 0; t < nTracks; t++) {
		if (str(4) !== 'MTrk') throw new RangeError(`midi: track ${t} missing MTrk`)
		let len = u32(), end = pos + len
		let tick = 0, status = 0
		let evs = []
		while (pos < end) {
			tick += vlq()
			let c = b[pos]
			if (c & 0x80) { status = c; pos++ } // else running status
			if (status === 0xff) {              // meta
				let type = b[pos++], n = vlq(), at = pos
				pos += n
				let ev = { tick, type: 'meta', meta: type }
				if (type === 0x51) ev.usPerBeat = b[at] << 16 | b[at + 1] << 8 | b[at + 2]
				else if (type === 0x58) ev.timeSignature = [b[at], 2 ** b[at + 1]]
				else if (type >= 1 && type <= 7) ev.text = String.fromCharCode(...b.subarray(at, at + n))
				else ev.data = b.slice(at, at + n)
				evs.push(ev)
			} else if (status === 0xf0 || status === 0xf7) {
				let n = vlq()
				evs.push({ tick, type: 'sysex', data: b.slice(pos, pos + n) })
				pos += n
			} else {
				let hi = status & 0xf0, ch = status & 0x0f
				let d1 = b[pos++] & 0x7f
				let d2 = (hi === 0xc0 || hi === 0xd0) ? 0 : b[pos++] & 0x7f
				let ev = hi === 0x90 && d2 > 0 ? { type: 'noteOn', midi: d1, velocity: d2 / 127 }
					: hi === 0x80 || hi === 0x90 ? { type: 'noteOff', midi: d1 }
					: hi === 0xb0 ? { type: 'controller', controller: d1, value: d2 }
					: hi === 0xc0 ? { type: 'program', program: d1 }
					: hi === 0xe0 ? { type: 'pitchBend', value: ((d2 << 7 | d1) - 8192) / 8192 }
					: hi === 0xa0 ? { type: 'aftertouch', midi: d1, value: d2 }
					: { type: 'channel', data: [d1, d2] }
				evs.push({ tick, channel: ch, ...ev })
			}
		}
		tracks.push(evs)
	}

	// tempo map: gather set-tempo across all tracks, tick → seconds
	let tempos = tracks.flat().filter(e => e.usPerBeat != null).sort((a, b2) => a.tick - b2.tick)
	if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerBeat: 500000 })
	let acc = 0
	for (let i = 0; i < tempos.length; i++) {
		if (i > 0) acc += (tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].usPerBeat / division / 1e6
		tempos[i] = { tick: tempos[i].tick, time: acc, usPerBeat: tempos[i].usPerBeat }
	}
	const toTime = (tick) => {
		let t = tempos[0]
		for (let x of tempos) { if (x.tick > tick) break; t = x }
		return t.time + (tick - t.tick) * t.usPerBeat / division / 1e6
	}

	// flatten notes: pair on/off per (track, channel, midi)
	let notes = []
	tracks.forEach((evs, ti) => {
		let open = new Map()
		for (let e of evs) {
			e.time = toTime(e.tick)
			let key = e.channel + ':' + e.midi
			if (e.type === 'noteOn') {
				if (open.has(key)) close(open.get(key), e.time)
				open.set(key, e)
			} else if (e.type === 'noteOff' && open.has(key)) {
				close(open.get(key), e.time)
				open.delete(key)
			}
		}
		for (let e of open.values()) close(e, e.time + 0.5)   // dangling — clamp
		function close (on, end) {
			notes.push({ time: on.time, duration: Math.max(0, end - on.time), midi: on.midi, velocity: on.velocity, channel: on.channel, track: ti })
		}
	})
	notes.sort((a, b2) => a.time - b2.time || a.midi - b2.midi)

	return { format, division, tracks, tempos, notes, duration: notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0) }
}
