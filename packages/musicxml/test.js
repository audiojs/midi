import test, { is, ok, almost, throws } from 'tst'
import write, { parse, toAbc, quantize } from './musicxml.js'

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

test('quantize — snaps onsets to the nearest grid and clips same-voice overlaps', () => {
	let notes = [{ time: 0.01, duration: 0.49, midi: 60 }, { time: 0.52, duration: 0.6, midi: 64 }]
	let q = quantize(notes, { bpm: 120, grid: 16 })
	is(q[0].beat, 0)
	is(q[1].beat, 1)
	ok(q[0].beat + q[0].beats <= q[1].beat + 1e-9, 'overlap resolved by clipping the earlier note')
})

test('write — throws on ambiguous input', () => {
	throws(() => write('not notes'), null, 'rejects non-array/non-{parts} input')
	throws(() => write({ parts: 'nope' }), null)
})

test('write — invalid key name throws', () => {
	throws(() => write([{ time: 0, duration: 1, midi: 60 }], { key: 'H' }), null)
})
