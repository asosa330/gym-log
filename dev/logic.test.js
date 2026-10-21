// Unit tests for logic.js. Run: node --test dev/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

const find = (s, name) => Object.values(s.exercises).find((e) => e.name === name);
const day = (s, name) => s.days.find((d) => d.name === name);

test('todayISO uses the local calendar date, not UTC', () => {
  // 11:30 pm local on Oct 20 is already Oct 21 in UTC for New York.
  assert.equal(L.todayISO(new Date(2026, 9, 20, 23, 30)), '2026-10-20');
  assert.equal(L.todayISO(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
});

test('date helpers', () => {
  assert.equal(L.fmtDate('2026-10-19', '2026-10-20'), 'Mon, Oct 19');
  assert.equal(L.fmtDate('2025-12-31', '2026-10-20'), 'Wed, Dec 31, 2025');
  assert.equal(L.isValidISO('2026-02-30'), false);
  assert.equal(L.isValidISO('2026-10-20'), true);
  assert.equal(L.daysBetween('2026-10-13', '2026-10-20'), 7);
  assert.equal(L.parseDateLoose('10/19/2026'), '2026-10-19');
  assert.equal(L.parseDateLoose('2026/10/9'), '2026-10-09');
  assert.equal(L.parseDateLoose('Oct 19'), null);
  assert.equal(L.fmtNum(22.5), '22.5');
  assert.equal(L.fmtNum(20), '20');
  assert.equal(L.fmtNum(0.1 + 0.2), '0.3');
});

test('seed data matches the Apple Notes log exactly', () => {
  const s = L.seedData();
  assert.deepEqual(s.days.map((d) => d.name), ['Push', 'Pull']);
  assert.deepEqual(day(s, 'Push').exIds.map((id) => s.exercises[id].name),
    ['Dumbbell shoulder press (seated)', 'Incline bench press', 'Dumbbell bicep', 'Bench press machine']);
  assert.deepEqual(day(s, 'Pull').exIds.map((id) => s.exercises[id].name),
    ['Lateral pull machine', 'Tricep pulley', 'Chin up machine', 'Seated row machine']);
  const expect = {
    'Dumbbell shoulder press (seated)': [['2026-10-13', 15], ['2026-10-19', 20]],
    'Incline bench press': [['2026-10-13', 20], ['2026-10-19', 25]],
    'Dumbbell bicep': [['2026-10-13', 15], ['2026-10-19', 20]],
    'Bench press machine': [['2026-10-13', 60], ['2026-10-19', 70]],
    'Lateral pull machine': [['2026-10-14', 85], ['2026-10-20', 90]],
    'Tricep pulley': [['2026-10-14', 30], ['2026-10-20', 35]],
    'Chin up machine': [['2026-10-20', 140]],
    'Seated row machine': [['2026-10-20', 40]]
  };
  for (const [name, rows] of Object.entries(expect)) {
    const ex = find(s, name);
    const got = L.entriesFor(s, ex.id);
    assert.deepEqual(got.map((e) => [e.date, e.weight]), rows, name);
    for (const e of got) { assert.equal(e.sets, 3); assert.equal(e.reps, 8); assert.equal(e.hit, true); }
  }
  assert.equal(s.entries.length, 14);
  assert.equal(find(s, 'Incline bench press').note, '+ bar');
  assert.equal(find(s, 'Chin up machine').assisted, true);
  assert.doesNotThrow(() => L.normalizeState(s));
});

test('last time, entry on a date, up next', () => {
  const s = L.seedData();
  const sp = find(s, 'Dumbbell shoulder press (seated)');
  assert.equal(L.lastBefore(s, sp.id, '2026-10-20').weight, 20);
  assert.equal(L.lastBefore(s, sp.id, '2026-10-19').weight, 15); // back-dating shows the session before
  assert.equal(L.lastBefore(s, sp.id, '2026-10-13'), null);
  const lat = find(s, 'Lateral pull machine');
  assert.equal(L.entryOn(s, lat.id, '2026-10-20').weight, 90);
  assert.equal(L.dayLastDone(s, day(s, 'Push')), '2026-10-19');
  assert.equal(L.dayLastDone(s, day(s, 'Pull')), '2026-10-20');
  assert.equal(L.upNextDayId(s), day(s, 'Push').id);
  // An empty day never becomes "up next".
  L.addDay(s, 'Legs');
  assert.equal(L.upNextDayId(s), day(s, 'Push').id);
});

test('progression nudge', () => {
  const ex = { inc: 5, assisted: false };
  assert.equal(L.suggest(ex, null), null);
  assert.deepEqual(L.suggest(ex, { weight: 20, sets: 3, reps: 8, hit: true }), { kind: 'up', weight: 25, sets: 3, reps: 8 });
  assert.deepEqual(L.suggest({ inc: 2.5 }, { weight: 20, sets: 3, reps: 8, hit: true }).weight, 22.5);
  assert.equal(L.suggest(ex, { weight: 20, sets: 3, reps: 8, hit: false }).kind, 'hold');
  assert.deepEqual(L.suggest(ex, { weight: 0, sets: 3, reps: 8, hit: true }), { kind: 'reps', weight: 0, sets: 3, reps: 9 });
  // Assisted: less assistance is progress.
  assert.equal(L.suggest({ inc: 5, assisted: true }, { weight: 140, sets: 3, reps: 8, hit: true }).weight, 135);
  assert.equal(L.suggest({ inc: 10, assisted: true }, { weight: 5, sets: 3, reps: 8, hit: true }).weight, 0);
});

test('mutations: days, exercises, entries', () => {
  const s = L.seedData();
  const legs = L.addDay(s, '  Legs ');
  assert.equal(legs.name, 'Legs');
  const sq = L.addExercise(s, legs.id, { name: 'Leg press', inc: 10 });
  assert.equal(sq.sets, 3); assert.equal(sq.reps, 8); assert.equal(sq.inc, 10);
  L.renameDay(s, legs.id, 'Legs & core');
  assert.equal(day(s, 'Legs & core').exIds[0], sq.id);
  assert.ok(L.moveDay(s, legs.id, -1));
  assert.deepEqual(s.days.map((d) => d.name), ['Push', 'Legs & core', 'Pull']);
  assert.equal(L.moveDay(s, s.days[0].id, -1), false);

  const pull = day(s, 'Pull');
  const row = find(s, 'Seated row machine');
  assert.ok(L.moveExercise(s, row.id, -1));
  assert.equal(pull.exIds[2], row.id);

  // Move an exercise to another day.
  L.updateExercise(s, row.id, { note: 'wide grip' }, legs.id);
  assert.ok(day(s, 'Legs & core').exIds.includes(row.id));
  assert.ok(!pull.exIds.includes(row.id));
  assert.equal(s.exercises[row.id].note, 'wide grip');

  const e = L.saveEntry(s, { exId: sq.id, date: '2026-10-21', weight: '90', sets: 3, reps: 10 });
  assert.equal(e.weight, 90); assert.equal(e.hit, true);
  L.saveEntry(s, Object.assign({}, e, { weight: 100, hit: false }));
  assert.equal(L.entriesFor(s, sq.id).length, 1);
  assert.equal(L.entriesFor(s, sq.id)[0].weight, 100);
  assert.throws(() => L.saveEntry(s, { exId: sq.id, date: '2026-13-01', weight: 5, sets: 1, reps: 1 }));
  assert.throws(() => L.saveEntry(s, { exId: sq.id, date: '2026-10-01', weight: -5, sets: 1, reps: 1 }));
  L.deleteEntry(s, e.id);
  assert.equal(L.entriesFor(s, sq.id).length, 0);

  const before = s.entries.length;
  L.deleteDay(s, day(s, 'Push').id);
  assert.equal(s.entries.length, before - 8);
  assert.ok(!find(s, 'Dumbbell bicep'));
});

test('normalizeState rejects junk and repairs damage', () => {
  assert.throws(() => L.normalizeState(null));
  assert.throws(() => L.normalizeState({ hello: 1 }));
  assert.throws(() => L.normalizeState(JSON.parse('[]')));
  const s = L.seedData();
  const raw = L.clone(s);
  raw.entries.push({ id: 'bad1', exId: 'nope', date: '2026-10-20', weight: 5, sets: 3, reps: 8 });
  raw.entries.push({ id: 'bad2', exId: raw.days[0].exIds[0], date: 'yesterday', weight: 5, sets: 3, reps: 8 });
  raw.entries.push({ id: 'bad3', exId: raw.days[0].exIds[0], date: '2026-10-20', weight: 'heavy', sets: 3, reps: 8 });
  raw.days[1].exIds.pop(); // orphan the seated row
  const n = L.normalizeState(raw);
  assert.equal(n.entries.length, 14);
  assert.equal(n.days[n.days.length - 1].name, 'Other');
  assert.equal(n.exercises[n.days[2].exIds[0]].name, 'Seated row machine');
});

test('CSV export guards formulas, round-trips, and handles quoting', () => {
  const s = L.seedData();
  const ex = find(s, 'Bench press machine');
  L.saveEntry(s, { exId: ex.id, date: '2026-10-21', weight: 75, sets: 3, reps: 8, hit: false, note: 'last set, "grindy"\nfelt off' });
  const csv = L.toCSV(s);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], L.CSV_COLUMNS.join(','));
  assert.equal(lines[1], '2026-10-13,Push,Dumbbell shoulder press (seated),15,lb,3,8,yes,,');
  assert.ok(csv.includes("'+ bar"), 'leading + is guarded for spreadsheets');

  const rows = L.parseCSV(csv);
  assert.equal(rows.length, 16);
  const last = rows[rows.length - 1];
  assert.equal(last[9], 'last set, "grindy"\nfelt off');
  assert.equal(last[7], 'no');

  const { state: back, skipped } = L.csvToState(csv);
  assert.equal(skipped, 0);
  assert.equal(back.entries.length, 15);
  assert.equal(find(back, 'Incline bench press').note, '+ bar');
  assert.equal(back.entries.find((e) => e.note.startsWith('last set')).hit, false);
});

test('CSV import is forgiving about order, dates and junk rows', () => {
  const text = '﻿Exercise,Weight,Sets,Reps,Date,Day\n' +
    'Leg press,180,3,10,10/22/2026,Legs\n' +
    'Leg press,,3,10,10/23/2026,Legs\n' +            // no weight -> skipped
    'Calf raise,90 lb,4,12,2026-10-22,legs\n' +       // day matches case-insensitively
    'Plank,0,3,1,not a date,Legs\n';                   // bad date -> skipped
  const { state, skipped } = L.csvToState(text);
  assert.equal(skipped, 2);
  assert.equal(state.days.length, 1);
  assert.equal(state.entries.length, 2);
  assert.equal(find(state, 'Calf raise').reps, 12);
  assert.throws(() => L.csvToState('a,b,c\n1,2,3'), /missing columns/);
});

test('merge: re-importing the same backup adds nothing', () => {
  const s = L.seedData();
  const backup = JSON.parse(L.exportJSON(s));
  const { state: merged, result } = L.mergeState(s, backup);
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 14);
  assert.equal(merged.entries.length, 14);
  assert.equal(merged.days.length, 2);
});

test('merge: new days, exercises and entries come in; names match loosely', () => {
  const s = L.seedData();
  const other = L.emptyState();
  const pull = L.addDay(other, 'pull');
  const ex = L.addExercise(other, pull.id, { name: 'tricep  pulley' });
  L.saveEntry(other, { exId: ex.id, date: '2026-10-27', weight: 40, sets: 3, reps: 8 });
  L.saveEntry(other, { exId: ex.id, date: '2026-10-20', weight: 35, sets: 3, reps: 8 }); // duplicate of seed
  const legs = L.addDay(other, 'Legs');
  const lp = L.addExercise(other, legs.id, { name: 'Leg press', note: 'sled' });
  L.saveEntry(other, { exId: lp.id, date: '2026-10-22', weight: 180, sets: 3, reps: 10 });

  const { state: m, result } = L.mergeState(s, other);
  assert.deepEqual(result, { added: 2, duplicates: 1, newDays: 1, newExercises: 1 });
  assert.deepEqual(m.days.map((d) => d.name), ['Push', 'Pull', 'Legs']);
  const tp = find(m, 'Tricep pulley');
  assert.deepEqual(L.entriesFor(m, tp.id).map((e) => e.weight), [30, 35, 40]);
  assert.equal(find(m, 'Leg press').note, 'sled');
  assert.equal(s.entries.length, 14, 'original state untouched');
});

test('merge from CSV export of another device', () => {
  const a = L.seedData();
  const b = L.seedData();
  const sp = find(b, 'Dumbbell shoulder press (seated)');
  L.saveEntry(b, { exId: sp.id, date: '2026-10-26', weight: 25, sets: 3, reps: 8 });
  const { state: inc } = L.csvToState(L.toCSV(b));
  const { state: m, result } = L.mergeState(a, inc);
  assert.equal(result.added, 1);
  assert.equal(result.duplicates, 14);
  assert.equal(L.lastBefore(m, find(m, 'Dumbbell shoulder press (seated)').id, '2026-10-30').weight, 25);
});

test('stats', () => {
  const s = L.seedData();
  const st = L.exerciseStats(s, find(s, 'Bench press machine').id);
  assert.equal(st.best, 70); assert.equal(st.change, 10); assert.equal(st.count, 2);
  const chin = L.exerciseStats(s, find(s, 'Chin up machine').id);
  assert.equal(chin.best, 140); assert.equal(chin.change, 0);
  assert.equal(L.exerciseStats(s, 'none').count, 0);
});
