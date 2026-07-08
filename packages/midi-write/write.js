// Standard MIDI file writer — note events → SMF format 0. The mir-transcribe output
// target: [{time, duration, midi, velocity, channel}] + tempo → bytes playable anywhere.

/**
 * @param {Array<{time, duration, midi, velocity=0.8, channel=0}>} notes — seconds
 * @param {object} opts — { bpm=120, division=480 (ticks/beat) }
 * @returns {Uint8Array} SMF format-0 bytes
 */
export default function write (notes, { bpm = 120, division = 480 } = {}) {
	let usPerBeat = Math.round(60e6 / bpm)
	let toTick = (t) => Math.max(0, Math.round(t * 1e6 / usPerBeat * division))

	// event list: tempo + note on/off pairs, sorted by tick (offs before ons at same tick)
	let evs = [{ tick: 0, bytes: [0xff, 0x51, 0x03, usPerBeat >> 16 & 0xff, usPerBeat >> 8 & 0xff, usPerBeat & 0xff], pri: 0 }]
	for (let n of notes) {
		let ch = (n.channel ?? 0) & 0x0f
		let vel = Math.max(1, Math.min(127, Math.round((n.velocity ?? 0.8) * 127)))
		let midi = Math.max(0, Math.min(127, Math.round(n.midi)))
		evs.push({ tick: toTick(n.time), bytes: [0x90 | ch, midi, vel], pri: 2 })
		evs.push({ tick: toTick(n.time + Math.max(0.001, n.duration ?? 0.5)), bytes: [0x80 | ch, midi, 0], pri: 1 })
	}
	evs.sort((a, b) => a.tick - b.tick || a.pri - b.pri)

	let out = []
	const vlq = (v) => {
		let stack = [v & 0x7f]
		while (v >>= 7) stack.push(v & 0x7f | 0x80)
		out.push(...stack.reverse())
	}
	let last = 0
	for (let e of evs) { vlq(e.tick - last); out.push(...e.bytes); last = e.tick }
	vlq(0); out.push(0xff, 0x2f, 0x00)      // end of track

	let head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, division >> 8, division & 0xff]
	let tlen = out.length
	let trk = [0x4d, 0x54, 0x72, 0x6b, tlen >>> 24 & 0xff, tlen >> 16 & 0xff, tlen >> 8 & 0xff, tlen & 0xff]
	return Uint8Array.from([...head, ...trk, ...out])
}
