import test, { is, ok, almost, throws } from 'tst'
import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import parseMidi from '@audio/midi-parse'
import abcjs from 'abcjs'
import write, { parse, toAbc, quantize } from './musicxml.js'
import { parse as parseXml, child, children, text } from './xml.js'
import { decompose } from './rhythm.js'

const SCALE_MIDI = [60, 62, 64, 65, 67, 69, 71, 72] // C D E F G A B c
const scaleNotes = (bpm = 120) => SCALE_MIDI.map((midi, i) => ({ time: i * (60 / bpm / 1), duration: 60 / bpm, midi, velocity: 0.8 }))
// ^ quarter = 60/bpm seconds

// ── tiny XML well-formedness checker: balanced tags via a stack ──
function assertWellFormed (xml) {
	let stack = []
	let re = /<(\/?)([a-zA-Z][\w.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g
	let m, count = 0
	while ((m = re.exec(xml))) {
		let [, closing, tag, , selfClose] = m
		count++
		if (closing) {
			let top = stack.pop()
			if (top !== tag) throw new Error(`mismatched close </${tag}> — expected </${top}>`)
		} else if (!selfClose) {
			stack.push(tag)
		}
	}
	if (stack.length) throw new Error(`unclosed tags: ${stack.join(', ')}`)
	ok(count > 0, 'parsed at least one tag')
	is(stack.length, 0, 'all tags balanced')
}

// direct child tag names of every <note>...</note> block, in document order
function noteChildOrder (xml) {
	let notes = []
	let noteRe = /<note>([\s\S]*?)<\/note>/g
	let m
	while ((m = noteRe.exec(xml))) {
		let body = m[1]
		let tags = [...body.matchAll(/<([a-zA-Z][\w.-]*)/g)].map(x => x[1])
		notes.push(tags)
	}
	return notes
}

test('write — C major scale: 2 measures of 4/4, quarter notes, no accidentals', () => {
	let xml = write(scaleNotes(120), { bpm: 120 })
	assertWellFormed(xml)
	is((xml.match(/<measure /g) || []).length, 2, '8 quarters in 4/4 → 2 measures')
	is((xml.match(/<type>quarter<\/type>/g) || []).length, 8, 'all 8 notes are quarters')
	ok(!xml.includes('<accidental>'), 'C major scale needs no accidentals')
	let steps = [...xml.matchAll(/<step>(\w)<\/step>/g)].map(m => m[1])
	is(steps.join(''), 'CDEFGABC', 'step letters')
	let octaves = [...xml.matchAll(/<octave>(\d)<\/octave>/g)].map(m => Number(m[1]))
	is(octaves.join(','), '4,4,4,4,4,4,4,5', 'octaves — scale crosses into octave 5 at the top C')
})

test('write → parse — roundtrip returns the original notes (time/duration in seconds)', () => {
	let input = scaleNotes(120)
	let out = parse(write(input, { bpm: 120 })).parts[0].notes
	is(out.length, input.length)
	for (let i = 0; i < input.length; i++) {
		almost(out[i].time, input[i].time, 1e-9, `note ${i} time`)
		almost(out[i].duration, input[i].duration, 1e-9, `note ${i} duration`)
		is(out[i].midi, input[i].midi, `note ${i} midi`)
	}
})

test('ties — note crossing a barline splits into two tied notes', () => {
	// 4/4 @ 120bpm: 1 beat = 0.5s. Note at beat 3 (1.5s) lasting 3 beats (1.5s) crosses into measure 2.
	let notes = [{ time: 0, duration: 1.5, midi: 60 }, { time: 1.5, duration: 1.5, midi: 64 }]
	let xml = write(notes, { bpm: 120 })
	assertWellFormed(xml)
	let ties = [...xml.matchAll(/<tie type="(\w+)"\/>/g)].map(m => m[1])
	is(ties.length, 2, 'one tie start, one tie stop')
	is(ties[0], 'start'); is(ties[1], 'stop')
	let tied = [...xml.matchAll(/<tied type="(\w+)"\/>/g)].map(m => m[1])
	is(tied.join(','), 'start,stop', 'notations/tied mirrors tie')
	// duration 1.5s at beat 3 = half note (2 beats) tied to a half note (last 2 beats of prior +?) — verify split beats
	let e4 = parse(xml).parts[0].notes[1]
	almost(e4.time, 1.5, 1e-9); almost(e4.duration, 1.5, 1e-9)
})

test('ties — a 5/16 duration splits into a tied quarter + 16th', () => {
	// 5/16 note = 5 sixteenths = 1.25 beats = 0.625s @ 120bpm
	let xml = write([{ time: 0, duration: 0.625, midi: 60 }], { bpm: 120 })
	assertWellFormed(xml)
	let types = [...xml.matchAll(/<type>(\w+)<\/type>/g)].map(m => m[1])
	is(types[0], 'quarter', 'first tied segment is a quarter')
	is(types[1], '16th', 'second tied segment is a 16th')
	let ties = [...xml.matchAll(/<tie type="(\w+)"\/>/g)].map(m => m[1])
	is(ties.join(','), 'start,stop', '5/16 = quarter tied to 16th')
	let note = parse(xml).parts[0].notes[0]
	almost(note.duration, 0.625, 1e-9, 'merges back to the original duration on parse')
})

test('triplets — three notes of 1/3 beat get time-modification 3:2, type eighth', () => {
	let notes = [0, 1, 2].map(i => ({ time: i * (0.5 / 3), duration: 0.5 / 3, midi: 60 + i }))
	let xml = write(notes, { bpm: 120 })
	assertWellFormed(xml)
	is((xml.match(/<time-modification>/g) || []).length, 3, 'all 3 notes carry time-modification')
	is((xml.match(/<actual-notes>3<\/actual-notes>/g) || []).length, 3)
	is((xml.match(/<normal-notes>2<\/normal-notes>/g) || []).length, 3)
	let types = [...xml.matchAll(/<type>(\w+)<\/type>/g)].map(m => m[1])
	is(types.slice(0, 3).join(','), 'eighth,eighth,eighth')
	is((xml.match(/<tuplet type="start"/g) || []).length, 1, 'bracket starts once')
	is((xml.match(/<tuplet type="stop"/g) || []).length, 1, 'bracket stops once')
})

test('triplets — disabling triplets quantizes the same input to 16ths', () => {
	let notes = [0, 1, 2].map(i => ({ time: i * (0.5 / 3), duration: 0.5 / 3, midi: 60 }))
	let q = quantize(notes, { bpm: 120, triplets: false })
	for (let n of q) is(n.tuplet, null, 'no triplet grid available')
	// 16th grid = 0.25 beat steps
	for (let n of q) almost(n.beat * 4, Math.round(n.beat * 4), 1e-9, 'onset lands on a 16th grid line')
})

test('chords — equal-duration simultaneous notes become one <chord/>-marked group', () => {
	let notes = [0, 4, 7].map(iv => ({ time: 0, duration: 1, midi: 60 + iv }))
	let xml = write(notes, { bpm: 60 })
	assertWellFormed(xml)
	is((xml.match(/<chord\/>/g) || []).length, 2, '2nd and 3rd notes marked <chord/>')
	is((xml.match(/<backup>/g) || []).length, 0, 'a chord needs no <backup>')
})

test('chords — unequal durations at the same onset become two voices with <backup>', () => {
	let notes = [{ time: 0, duration: 2, midi: 60 }, { time: 0, duration: 1, midi: 72 }]
	let xml = write(notes, { bpm: 60 })
	assertWellFormed(xml)
	is((xml.match(/<backup>/g) || []).length, 1)
	is((xml.match(/<voice>1<\/voice>/g) || []).length >= 1, true)
	is((xml.match(/<voice>2<\/voice>/g) || []).length >= 1, true)
	let notesOut = parse(xml).parts[0].notes
	is(notesOut.length, 2)
})

test('key spelling — G major: F# is diatonic (no accidental), F natural gets a courtesy natural', () => {
	let notes = [{ time: 0, duration: 0.5, midi: 66 }, { time: 0.5, duration: 0.5, midi: 65 }]
	let xml = write(notes, { bpm: 120, key: 1 })
	assertWellFormed(xml)
	let pitches = [...xml.matchAll(/<pitch>[\s\S]*?<\/pitch>/g)].map(m => m[0])
	ok(pitches[0].includes('<step>F</step>') && pitches[0].includes('<alter>1</alter>'), 'F# spelled as F+alter1')
	let accidentals = [...xml.matchAll(/<accidental>(\w+)<\/accidental>/g)].map(m => m[1])
	is(accidentals.length, 1, 'only the F-natural needs an explicit accidental')
	is(accidentals[0], 'natural')
})

test('key spelling — F minor spells Ab/Bb/Db/Eb (not sharps)', () => {
	let notes = [68, 70, 61, 63].map((midi, i) => ({ time: i * 0.5, duration: 0.5, midi }))
	let xml = write(notes, { bpm: 120, key: -4, mode: 'minor' })
	assertWellFormed(xml)
	let steps = [...xml.matchAll(/<step>(\w)<\/step>/g)].map(m => m[1])
	let alters = [...xml.matchAll(/<pitch>[\s\S]*?<\/pitch>/g)].map(p => /<alter>(-?\d)<\/alter>/.exec(p[0])?.[1] ?? '0')
	is(steps.join(','), 'A,B,D,E', 'letters')
	is(alters.join(','), '-1,-1,-1,-1', 'all flatted — Ab Bb Db Eb')
})

test('drums — mir-drums events become a percussion part with <unpitched> and a percussion clef', () => {
	let drums = [
		{ time: 0, duration: 0.2, type: 'kick', strength: 1 },
		{ time: 0.25, duration: 0.2, type: 'snare', strength: 0.8 },
		{ time: 0.5, duration: 0.2, type: 'hihat', strength: 0.5 },
	]
	let xml = write({ parts: [{ name: 'Drums', notes: drums, percussion: true }] }, { bpm: 120 })
	assertWellFormed(xml)
	ok(xml.includes('<sign>percussion</sign>'), 'percussion clef')
	is((xml.match(/<unpitched>/g) || []).length, 3)
	ok(xml.includes('<display-step>F</display-step>') && xml.includes('<display-octave>4</display-octave>'), 'kick → F4')
	ok(xml.includes('<display-step>C</display-step>') && xml.includes('<display-octave>5</display-octave>'), 'snare → C5')
	ok(xml.includes('<display-step>G</display-step>') && xml.includes('<display-octave>5</display-octave>'), 'hihat → G5')
	let parsed = parse(xml).parts[0].notes
	is(parsed.map(n => n.midi).join(','), '36,38,42', 'GM percussion numbers recovered on parse')
})

test('tempo map — piecewise tempo change lands later notes on the correct beat/time', () => {
	let tempos = [{ time: 0, bpm: 120 }, { time: 4, bpm: 60 }]
	// at 120bpm, t=4s = beat 8; from there at 60bpm, a note at t=4.5s = beat 8.5
	let notes = [{ time: 0, duration: 0.5, midi: 60 }, { time: 4.5, duration: 0.5, midi: 64 }]
	let xml = write(notes, { tempos })
	assertWellFormed(xml)
	ok(xml.includes('<per-minute>120</per-minute>'), 'initial tempo direction')
	ok(xml.includes('<per-minute>60</per-minute>'), 'tempo-change direction')
	let out = parse(xml)
	let bpms = out.parts[0].tempos.map(t => t.bpm)
	is(bpms.join(','), '120,60')
	let secondNote = out.parts[0].notes.find(n => n.midi === 64)
	almost(secondNote.time, 4.5, 1e-6, 'note after the tempo change lands back at 4.5s')
})

test('toAbc — C major scale renders exactly per the ABC 2.1 header/body convention', () => {
	let abc = toAbc(scaleNotes(120), { bpm: 120, title: 'Test' })
	let lines = abc.split('\n')
	is(lines[0], 'X:1')
	ok(lines[1].startsWith('T:'))
	is(lines[2], 'M:4/4')
	is(lines[3], 'L:1/4')
	is(lines[4], 'Q:1/4=120')
	is(lines[5], 'K:C')
	let body = lines.slice(6).join('\n').trim()
	is(body.replace(/\s+/g, ' '), 'C D E F | G A B c |]')
})

test('structural validity — element order inside <note>: pitch/unpitched, duration, tie, voice, type, dot, accidental, time-modification, staff, notations', () => {
	const ORDER = ['chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'voice', 'type', 'dot', 'accidental', 'time-modification', 'stem', 'notehead', 'staff', 'beam', 'notations']
	let rank = (tag) => ORDER.indexOf(tag)
	// exercise chords, ties, triplets, accidentals and percussion all at once
	let notes = [
		{ time: 0, duration: 1.5, midi: 66 }, { time: 1.5, duration: 1.5, midi: 65 },
		...[0, 1, 2].map(i => ({ time: 3 + i * (1 / 3), duration: 1 / 3, midi: 60 })),
	]
	let xml = write(notes, { bpm: 240, key: 1 })
	assertWellFormed(xml)
	for (let tags of noteChildOrder(xml)) {
		let ranks = tags.map(rank).filter(r => r >= 0)
		for (let i = 1; i < ranks.length; i++) ok(ranks[i] >= ranks[i - 1], `out of order: ${tags.join(',')}`)
	}
})

test('structural validity — parses the MusicXML tutorial "Hello World" example', () => {
	// Hand-transcribed from the MusicXML 4.0 tutorial, "Hello World" (musicxml.org / W3C
	// Music Notation CG, https://www.w3.org/2021/06/musicxml40/tutorial/hello-world/).
	let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC
    "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
    "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1">
      <part-name>Music</part-name>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>`
	let result = parse(xml)
	is(result.parts.length, 1)
	is(result.parts[0].name, 'Music')
	is(result.parts[0].notes.length, 1)
	is(result.parts[0].notes[0].midi, 60)
	almost(result.parts[0].notes[0].duration, 2, 1e-9, 'whole note @ default 120bpm = 2s')
})

test('parse robustness — score-timewise, <forward>/<backup>, dotted rests', () => {
	let xml = `<?xml version="1.0"?>
<score-timewise version="4.0">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <measure number="1">
    <part id="P1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <forward><duration>2</duration></forward>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>eighth</type></note>
      <backup><duration>2</duration></backup>
      <note><rest/><duration>2</duration><type>eighth</type><dot/></note>
    </part>
  </measure>
</score-timewise>`
	let out = parse(xml).parts[0]
	is(out.notes.length, 2, 'score-timewise part collected across the single <measure>')
	almost(out.notes[0].time, 0, 1e-9)
	almost(out.notes[0].duration, 1, 1e-9, 'quarter @ 120bpm default')
	almost(out.notes[1].time, 1.5, 1e-9, 'forward skips a beat before the 2nd note')
	almost(out.notes[1].duration, 0.5, 1e-9)
})

test('parse robustness — ties expressed only via <notations><tied> (no <tie>) still merge', () => {
	let xml = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><notations><tied type="start"/></notations></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>`
	let notes = parse(xml).parts[0].notes
	is(notes.length, 1, 'the two tied quarters merge into one half-note-length event')
	almost(notes[0].duration, 1, 1e-9, '2 quarters @ 120bpm default = 1s')
})

test('quantize — snaps onsets to the nearest grid; an overlapping note is kept whole', () => {
	let notes = [{ time: 0.01, duration: 0.49, midi: 60 }, { time: 0.52, duration: 0.6, midi: 64 }]
	let q = quantize(notes, { bpm: 120, grid: 16 })
	is(q[0].beat, 0)
	is(q[1].beat, 1)
	is(q[0].beats, 1, 'onset and end snap to the grid')
	let held = quantize([{ time: 0, duration: 2, midi: 48 }, { time: 0.5, duration: 0.5, midi: 72 }], { bpm: 120 })
	is(held.map(n => n.beats), [4, 1], 'a held note under a later one keeps its length: overlap is polyphony, not an error')
})

test('write — throws on ambiguous input', () => {
	throws(() => write('not notes'), null, 'rejects non-array/non-{parts} input')
	throws(() => write({ parts: 'nope' }), null)
})

test('write — invalid key name throws', () => {
	throws(() => write([{ time: 0, duration: 1, midi: 60 }], { key: 'H' }), null)
})

// ── voices: notes that overlap within one part ──────────────────────────────────────────────
// MusicXML 4.0 (https://www.w3.org/2021/06/musicxml40/) holds a part's overlapping notes in
// voices: <voice> names a note's voice, <backup> rewinds to write the next voice over the same
// measure, <chord/> stacks a note on the one before it. These invariants hold for every score.

const written = [] // every score the checks below see, validated against the XSD at the end

/** Every measure of every part: voice 1 written; each voice's notes and rests sum to exactly the
 *  measure's ticks; <backup> rewinds exactly to the measure start; a <chord/> note shares its
 *  chord's voice and duration. Returns each part's voice count. */
function assertMeasures (xml, label) {
	written.push(xml)
	let problems = [], counts = []
	for (let part of children(parseXml(xml), 'part')) {
		let div, ts, voices = new Set()
		for (let m of children(part, 'measure')) {
			let attrs = child(m, 'attributes'), time = attrs && child(attrs, 'time')
			if (attrs && child(attrs, 'divisions')) div = Number(text(attrs, 'divisions'))
			if (time) ts = [Number(text(time, 'beats')), Number(text(time, 'beat-type'))]
			let full = ts[0] * 4 / ts[1] * div, at = `${part.attrs.id} m${m.attrs.number}`
			let sums = new Map(), pos = 0, head = null
			for (let n of m.children) {
				if (n.tag === 'backup') { if (Number(text(n, 'duration')) !== pos) problems.push(`${at}: <backup> ${text(n, 'duration')} from ${pos}`); pos = 0 }
				if (n.tag !== 'note') continue
				let v = text(n, 'voice'), d = Number(text(n, 'duration'))
				if (!(d > 0) || !Number.isInteger(d)) problems.push(`${at}: duration ${d}`)
				if (child(n, 'chord')) { if (head?.v !== v || head?.d !== d) problems.push(`${at}: <chord/> off its chord`); continue }
				head = { v, d }
				sums.set(v, (sums.get(v) ?? 0) + d)
				pos += d
				voices.add(v)
			}
			if (!sums.has('1')) problems.push(`${at}: no voice 1`)
			for (let [v, t] of sums) if (t !== full) problems.push(`${at} voice ${v}: ${t} ticks in ${full}`)
		}
		counts.push(voices.size)
	}
	is(problems, [], `${label}: every voice fills every measure exactly`)
	return counts
}

const quantizeAs = (notes, opts) => quantize(notes, { bpm: opts.bpm, grid: opts.quantize, triplets: opts.triplets })

/** The most chords sounding at once: notes sharing onset and end are one chord, a pitch repeated
 *  in it counting again. Greedy voice assignment by onset needs exactly this many voices. */
function mostChords (q) {
	let r = x => Math.round(x * 1e6), spans = new Map()
	for (let n of q) {
		let k = `${r(n.beat)}:${r(n.beat + n.beats)}`
		if (!spans.has(k)) spans.set(k, { from: r(n.beat), to: r(n.beat + n.beats), pitches: [] })
		spans.get(k).pitches.push(n.midi)
	}
	let edges = [...spans.values()].flatMap(s => {
		let w = Math.max(...s.pitches.map(p => s.pitches.filter(x => x === p).length))
		return [[s.from, w], [s.to, -w]]
	}).sort((a, b) => a[0] - b[0] || a[1] - b[1])
	let on = 0, most = 0
	for (let [, w] of edges) most = Math.max(most, on += w)
	return Math.max(1, most)
}

/** Write the score, check every measure and voice, the voice count, and that the notes read back
 *  (start, duration, pitch) equal the input as the writer quantizes it. */
function check (label, input, opts = {}) {
	let parts = Array.isArray(input) ? [input] : input.parts.map(p => p.notes)
	let xml = write(input, opts)
	let q = parts.map(notes => quantizeAs(notes, opts))
	is(assertMeasures(xml, label), q.map(mostChords), `${label}: as many voices as chords sounding at once`)
	let bps = (opts.bpm ?? 120) / 60, key = (beat, beats, midi) => `${beat.toFixed(6)}+${beats.toFixed(6)}:${midi}`
	let back = parse(xml).parts.map(p => p.notes.map(n => key(n.time * bps, n.duration * bps, n.midi)).sort())
	is(back, q.map(qn => qn.map(n => key(n.beat, n.beats, n.midi)).sort()), `${label}: notes read back equal the quantized input`)
	return xml
}

/** abcjs parses the tune with no warnings, as one system; every bar of every voice sums to the
 *  meter (abcjs durations are in whole notes, a tuplet's scaled by its multiplier). */
function assertAbc (abc, beatsPerBar, label) {
	let [tune] = abcjs.parseOnly(abc)
	is(tune.warnings ?? [], [], `${label}: abcjs parses it with no warnings`)
	let lines = tune.lines.filter(l => l.staff)
	is(lines.length, 1, `${label}: one system`)
	let problems = [], voices = 0
	for (let staff of lines[0].staff) for (let voice of staff.voices) {
		voices++
		let bar = 0, scale = 1, bars = 0
		for (let el of voice) {
			if (el.el_type === 'note') { if (el.startTriplet) scale = el.tripletMultiplier; bar += el.duration * scale; if (el.endTriplet) scale = 1 }
			if (el.el_type !== 'bar') continue
			bars++
			if (Math.abs(bar * 4 - beatsPerBar) > 1e-9) problems.push(`voice ${voices} bar ${bars}: ${bar * 4} beats`)
			bar = 0
		}
	}
	is(problems, [], `${label}: every bar of every ABC voice fills the meter`)
	return { voices, staves: lines[0].staff.map(s => s.voices.length) }
}

// J.S. Bach, BWV 846 Prelude in C, MIDI by the Mutopia Project, public domain — the fixture
// @audio/midi-render tests with (see its test.js for provenance). Piano, 60 bpm, 4/4: a half-note
// bass and a held tenor under 16th-note figures, up to 5 notes at once.
const bwv846 = parseMidi(new Uint8Array(readFileSync(new URL('../midi-render/fixtures/bwv846-prelude.mid', import.meta.url))))
	.notes.map(({ time, duration, midi, channel }) => ({ time, duration, midi, channel }))

test('rhythm — every 1/24-beat multiple splits into notated values summing exactly, each value its type', () => {
	const TYPE = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625 }
	let off = []
	for (let k = 1; k <= 96; k++) {
		let beats = k / 24, run = decompose(beats)
		if (Math.abs(run.reduce((s, p) => s + p.beats, 0) - beats) > 1e-9) off.push(`${k}/24 sums to ${run.reduce((s, p) => s + p.beats, 0)}`)
		for (let p of run) if (Math.abs(TYPE[p.type] * (p.dots ? 1.5 : 1) * (p.tuplet ? 2 / 3 : 1) - p.beats) > 1e-9) off.push(`${k}/24: ${p.type}${p.dots ? '.' : ''}${p.tuplet ? ' 3:2' : ''} for ${p.beats}`)
	}
	is(off, [], 'k/24 beat, k = 1..96: the 1/8 grid, the triplet grids, and the gaps between them')
	is(decompose(11 / 8).map(p => p.type + '.'.repeat(p.dots)), ['quarter', '16th.'], '11/8 beat: quarter tied to dotted 16th')
})

test('voices — a whole-note bass held under an eighth-note melody: two voices, each a full bar', () => {
	let melody = [72, 74, 76, 77, 79, 77, 76, 74].map((midi, i) => ({ time: i / 2, duration: 0.5, midi }))
	let bass = { time: 0, duration: 4, midi: 48 }
	let xml = check('held bass', [bass, ...melody], { bpm: 60 })
	is((xml.match(/<backup>/g) || []).length, 1, 'one <backup> to the second voice')
	let back = parse(xml).parts[0].notes
	ok(back.find(n => n.midi === 48).voice !== back.find(n => n.midi === 72).voice, 'bass and melody in separate voices')
	is(write([...melody, bass], { bpm: 60 }), xml, 'input order does not change the score')
})

test('voices — a chord whose notes end at different times: equal lengths share a <chord/>, others take voices', () => {
	let notes = [
		{ time: 0, duration: 4, midi: 48 }, { time: 0, duration: 3, midi: 55 },
		{ time: 0, duration: 2, midi: 64 }, { time: 0, duration: 2, midi: 67 }, { time: 1, duration: 1, midi: 72 },
	]
	let xml = check('staggered chord', notes, { bpm: 60 })
	is((xml.match(/<chord\/>/g) || []).length, 1, 'E4 and G4, same onset and length: one chord')
})

test('voices — notes crossing barlines are cut and tied, each tie inside its voice', () => {
	let notes = [{ time: 3, duration: 2, midi: 60 }, { time: 2.5, duration: 6, midi: 43 }, { time: 7.5, duration: 1.25, midi: 67 }]
	let xml = check('across barlines', notes, { bpm: 60 })
	is((xml.match(/<tie type="start"\/>/g) || []).length, 4, 'G2 cut at two barlines, C4 and G4 at one each')
	is((xml.match(/<measure /g) || []).length, 3)
})

test('voices — a single note, and empty input: one voice of whole bars', () => {
	check('single note', [{ time: 1, duration: 1.5, midi: 61 }], { bpm: 60 })
	let xml = check('empty', [], { bpm: 60 })
	ok(xml.includes('<rest measure="yes"/>'), 'empty input: one whole-measure rest')
	assertAbc(toAbc([], { bpm: 60 }), 4, 'empty ABC')
})

test('voices — overlapping identical pitches: each sounding copy keeps its own voice', () => {
	let notes = [
		{ time: 0, duration: 2, midi: 60 }, { time: 1, duration: 2, midi: 60 }, { time: 1, duration: 2, midi: 60 },
		{ time: 4, duration: 1, midi: 60 }, { time: 4, duration: 1, midi: 64 },
	]
	let xml = check('identical pitches', notes, { bpm: 60 })
	is((xml.match(/<chord\/>/g) || []).length, 1, 'only C4 + E4 at beat 4 is a chord: a chord holds one notehead per pitch')
})

test('voices — BWV 846 prelude as one piano part: every bar exact, every note back, order-independent', () => {
	let xml = check('BWV 846', bwv846, { bpm: 60 })
	is((xml.match(/<measure /g) || []).length, 35, '140 beats of 4/4')
	is(write([...bwv846].reverse(), { bpm: 60 }), xml, 'input order does not change the score')
	check('BWV 846 hands', { parts: [{ name: 'Right hand', notes: bwv846.filter(n => n.channel === 1) }, { name: 'Left hand', notes: bwv846.filter(n => n.channel === 0) }] }, { bpm: 60 })
})

test('voices — seeded random polyphony over grids, triplets and meters: every bar exact, every note back', () => {
	let seed = 846, rand = () => (seed = seed * 16807 % 2147483647) / 2147483647 // Park–Miller minimal standard
	let meters = [[4, 4], [3, 4], [6, 8], [5, 4], [7, 8], [2, 2]]
	for (let c = 0; c < 12; c++) {
		let notes = Array.from({ length: 60 }, () => ({ time: rand() * 20, duration: 0.05 + rand() * 3, midi: 36 + Math.floor(rand() * 48) }))
		let [num, den] = meters[c % meters.length]
		let opts = { bpm: 60, quantize: [8, 16, 32][c % 3], triplets: c % 2 === 0, timeSignature: [num, den] }
		check(`random ${c}`, notes, opts)
		let { voices } = assertAbc(toAbc(notes, opts), num * 4 / den, `random ${c} ABC`)
		is(voices, mostChords(quantizeAs(notes, opts)), `random ${c} ABC: one ABC voice per voice`)
	}
})

test('toAbc — parts are voices of one tune (ABC 2.1 §7), a part\'s voices share its staff (§11.1 %%score)', () => {
	let melody = [76, 77, 79, 77].map((midi, i) => ({ time: i, duration: 1, midi }))
	let piano = [{ time: 0, duration: 4, midi: 48 }, { time: 0, duration: 2, midi: 64 }, { time: 2, duration: 2, midi: 65 }]
	let abc = toAbc({ parts: [{ name: 'Melody', notes: melody }, { name: 'Piano', notes: piano }] }, { bpm: 60 })
	ok(!/\n\s*\n/.test(abc), 'no blank line: a blank line ends a tune (§2.2.4)')
	is((abc.match(/^X:/gm) || []).length, 1, 'one tune')
	ok(abc.includes('%%score 1 (2 3)'), 'Melody on its own staff, the piano\'s two voices on one')
	ok(abc.includes('V:1 name="Melody"') && abc.includes('V:2 name="Piano"'), 'each part named on its first voice')
	is(assertAbc(abc, 4, 'two parts'), { voices: 3, staves: [1, 2] })
})

test('toAbc — BWV 846: one piano part, and both hands as two parts, parse in abcjs voice for voice', () => {
	let one = assertAbc(toAbc(bwv846, { bpm: 60 }), 4, 'BWV 846 ABC')
	is(one, { voices: mostChords(quantizeAs(bwv846, { bpm: 60 })), staves: [one.voices] }, 'every voice on the one staff')
	let rh = bwv846.filter(n => n.channel === 1), lh = bwv846.filter(n => n.channel === 0)
	let two = assertAbc(toAbc({ parts: [{ name: 'Right hand', notes: rh }, { name: 'Left hand', notes: lh }] }, { bpm: 60 }), 4, 'BWV 846 hands ABC')
	let want = [rh, lh].map(n => mostChords(quantizeAs(n, { bpm: 60 })))
	is(two, { voices: want[0] + want[1], staves: want })
})

// MusicXML 4.0 XSD, offline: tag v4.0 of github.com/w3c/musicxml, schema/musicxml.xsd with the
// xml.xsd and xlink.xsd it imports saved beside it and its two <xs:import schemaLocation>s pointed
// at those copies. Run: MUSICXML_XSD=/path/to/musicxml.xsd npm test (needs xmllint).
const XSD = process.env.MUSICXML_XSD
;(XSD ? test : test.skip)('MusicXML 4.0 XSD — every score the voice checks wrote validates (xmllint, MUSICXML_XSD)', () => {
	for (let [i, xml] of written.entries()) {
		let r = spawnSync('xmllint', ['--nonet', '--noout', '--schema', XSD, '-'], { input: xml, encoding: 'utf8' })
		is(r.status, 0, `score ${i + 1} of ${written.length} is schema-valid` + (r.status ? ': ' + (r.stderr || r.error?.message || '').split('\n')[0] : ''))
	}
})
