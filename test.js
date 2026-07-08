import test, { almost, ok, is } from 'tst'
import { parse, write } from './index.js'

test('write → parse roundtrip preserves notes, tempo, timing', () => {
	let notes = [
		{ time: 0, duration: 0.5, midi: 60, velocity: 0.8 },
		{ time: 0.5, duration: 0.25, midi: 64, velocity: 0.5 },
		{ time: 0.5, duration: 1, midi: 67, velocity: 1, channel: 2 },
	]
	let smf = write(notes, { bpm: 120 })
	ok(smf instanceof Uint8Array && smf.length > 30)
	is(String.fromCharCode(...smf.subarray(0, 4)), 'MThd')
	let m = parse(smf)
	is(m.notes.length, 3)
	let byMidi = Object.fromEntries(m.notes.map(n => [n.midi, n]))
	almost(byMidi[60].time, 0, 1e-3); almost(byMidi[60].duration, 0.5, 1e-2)
	almost(byMidi[64].time, 0.5, 1e-3); almost(byMidi[64].velocity, 0.5, 0.01)
	is(byMidi[67].channel, 2)
	almost(m.duration, 1.5, 1e-2)
	almost(m.tempos[0].usPerBeat, 500000, 1)
})

test('parse — running status, tempo change mid-file', () => {
	// hand-built SMF: 960 division, tempo 120 → then 60 bpm at beat 1; two notes using running status
	let bytes = [
		0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0x03,0xc0,       // MThd fmt0 1trk div 960
		0x4d,0x54,0x72,0x6b, 0,0,0,29,                            // MTrk len 29
		0x00, 0xff,0x51,0x03, 0x07,0xa1,0x20,                     // tempo 500000 (120 bpm)
		0x00, 0x90, 60, 100,                                      // noteOn C4
		0x87,0x40, 60, 0,                                         // (running status) +960 ticks noteOn vel0 = off
		0x00, 0xff,0x51,0x03, 0x0f,0x42,0x40,                     // tempo 1000000 (60 bpm)
		0x00, 0x90, 62, 100,                                      // noteOn D4 (running... new status given)
		0x87,0x40, 62, 0,                                         // +960 off
		0x00, 0xff,0x2f,0x00,                                     // EOT
	]
	let m = parse(Uint8Array.from(bytes))
	is(m.notes.length, 2)
	almost(m.notes[0].time, 0, 1e-9)
	almost(m.notes[0].duration, 0.5, 1e-3, 'first note at 120 bpm = 0.5 s')
	almost(m.notes[1].time, 0.5, 1e-3)
	almost(m.notes[1].duration, 1, 1e-3, 'second note at 60 bpm = 1 s')
})

test('parse — rejects non-SMF input', () => {
	let threw = false
	try { parse(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])) } catch { threw = true }
	ok(threw)
})
