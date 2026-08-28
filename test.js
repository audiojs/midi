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

// -- 2026-08 atoms: render (GM synth), musicxml, subtitle — smoke through the umbrella; depth lives in each package --
import { render, musicxml, parseMusicxml, toAbc, subtitle } from './index.js'

test('render — a written SMF renders to PCM with the note audible at its pitch', () => {
	let smf = write([{ time: 0, duration: 0.5, midi: 69, velocity: 0.9 }], { bpm: 120 })
	let { channelData, sampleRate } = render(smf, { fs: 44100, channels: 1 })
	is(sampleRate, 44100)
	ok(channelData[0].length > 0.5 * 44100, 'covers the note + tail')
	let g = f => { let w = 2 * Math.PI * f / 44100, c = 2 * Math.cos(w), s1 = 0, s2 = 0; for (let i = 0; i < 22050; i++) { let s0 = channelData[0][i] + c * s1 - s2; s2 = s1; s1 = s0 } return s1 * s1 + s2 * s2 - c * s1 * s2 }
	ok(g(440) > 10 * g(415.3), '440 Hz dominates its lower neighbour semitone')
})

test('musicxml — notes → score → notes round trip; ABC body', () => {
	let notes = [60, 62, 64, 65].map((midi, i) => ({ time: i * 0.5, duration: 0.5, midi, velocity: 0.8 }))
	let xml = musicxml(notes, { bpm: 120, title: 'Scale' })
	ok(xml.includes('<score-partwise') && xml.includes('<step>C</step>'), 'MusicXML document')
	let back = parseMusicxml(xml)
	is(back.parts[0].notes.map(n => n.midi).join(','), '60,62,64,65', 'pitches survive')
	almost(back.parts[0].notes[3].time, 1.5, 1e-6, 'timing survives')
	ok(/C D E F/.test(toAbc(notes, { bpm: 120 })), 'ABC body')
})

test('subtitle — SRT ↔ VTT ↔ LRC through the namespace export', () => {
	let cues = [{ start: 1, end: 2.5, text: 'Hare Krishna' }, { start: 3, end: 4, text: 'Hare Rama' }]
	let srt = subtitle.write(cues, 'srt')
	ok(srt.startsWith('1\n00:00:01,000 --> 00:00:02,500\nHare Krishna'), 'SRT text')
	let vtt = subtitle.write(subtitle.parse(srt), 'vtt')
	ok(vtt.startsWith('WEBVTT'), 'VTT header')
	is(subtitle.parse(vtt).cues.length, 2, 'VTT parses back')
	ok(/\[00:01\.00\]Hare Krishna/.test(subtitle.write(cues, 'lrc')), 'LRC line')
})
