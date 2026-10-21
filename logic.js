/* Gym Log: pure data logic (no DOM, no storage).
   Runs as a classic browser script (window.GymLogic) and as a Node module for tests. */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  let uidCounter = 0;

  // ---------- small helpers ----------
  function uid() {
    uidCounter = (uidCounter + 1) % 1679616;
    return Date.now().toString(36) + uidCounter.toString(36).padStart(4, '0') +
      Math.random().toString(36).slice(2, 7);
  }
  const pad = (n) => String(n).padStart(2, '0');

  /** Local calendar date as YYYY-MM-DD (never UTC, so late-night workouts land on the right day). */
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function isoToDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  function isValidISO(iso) {
    if (typeof iso !== 'string' || !DATE_RE.test(iso)) return false;
    const d = isoToDate(iso);
    return todayISO(d) === iso;
  }
  function daysBetween(a, b) {
    return Math.round((isoToDate(b) - isoToDate(a)) / 86400000);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** "Mon, Oct 19" (adds the year when it isn't the reference year). */
  function fmtDate(iso, refISO) {
    if (!iso) return '';
    const d = isoToDate(iso);
    const ref = refISO || todayISO();
    let s = WEEKDAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    if (ref.slice(0, 4) !== iso.slice(0, 4)) s += ', ' + d.getFullYear();
    return s;
  }
  /** "Oct 19" short form for charts. */
  function fmtShort(iso) {
    const d = isoToDate(iso);
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return '';
    return String(round2(Number(n)));
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

  // ---------- state shape ----------
  function emptyState() {
    return {
      app: 'gymlog',
      schema: SCHEMA,
      unit: 'lb',
      rest: 90,
      showTimer: true,
      lastBackup: null,
      created: Date.now(),
      savedAt: 0,
      days: [],          // [{id, name, exIds: []}]  (order = display order)
      exercises: {},     // {id: {id, name, note, inc, assisted, sets, reps}}
      entries: []        // [{id, exId, date, weight, sets, reps, hit, note, ts}]
    };
  }
  function makeExercise(fields) {
    return {
      id: fields.id || uid(),
      name: String(fields.name || 'Exercise').trim(),
      note: String(fields.note || '').trim(),
      inc: Number(fields.inc) > 0 ? round2(Number(fields.inc)) : 5,
      assisted: !!fields.assisted,
      sets: toPosInt(fields.sets, 3),
      reps: toPosInt(fields.reps, 8)
    };
  }
  function toPosInt(v, dflt) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 999) : dflt;
  }

  /** Antonio's log from Apple Notes, Oct 13-20, 2026. All 3x8, all reps hit. */
  function seedData() {
    const s = emptyState();
    const plan = [
      ['Push', [
        ['Dumbbell shoulder press (seated)', '', false, [['2026-10-13', 15], ['2026-10-19', 20]]],
        ['Incline bench press', '+ bar', false, [['2026-10-13', 20], ['2026-10-19', 25]]],
        ['Dumbbell bicep', '', false, [['2026-10-13', 15], ['2026-10-19', 20]]],
        ['Bench press machine', '', false, [['2026-10-13', 60], ['2026-10-19', 70]]]
      ]],
      ['Pull', [
        ['Lateral pull machine', '', false, [['2026-10-14', 85], ['2026-10-20', 90]]],
        ['Tricep pulley', '', false, [['2026-10-14', 30], ['2026-10-20', 35]]],
        ['Chin up machine', 'assisted', true, [['2026-10-20', 140]]],
        ['Seated row machine', '', false, [['2026-10-20', 40]]]
      ]]
    ];
    let ts = Date.UTC(2026, 9, 13, 22);
    for (const [dayName, list] of plan) {
      const day = { id: uid(), name: dayName, exIds: [] };
      s.days.push(day);
      for (const [name, note, assisted, logs] of list) {
        const ex = makeExercise({ name, note, assisted, inc: 5, sets: 3, reps: 8 });
        s.exercises[ex.id] = ex;
        day.exIds.push(ex.id);
        for (const [date, weight] of logs) {
          s.entries.push({ id: uid(), exId: ex.id, date, weight, sets: 3, reps: 8, hit: true, note: '', ts: ts++ });
        }
      }
    }
    return s;
  }

  // ---------- queries ----------
  function byDateThenTs(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.ts || 0) - (b.ts || 0);
  }
  function entriesFor(state, exId) {
    return state.entries.filter((e) => e.exId === exId).sort(byDateThenTs);
  }
  /** Most recent entry strictly before `date` (what you did "last time"). */
  function lastBefore(state, exId, date) {
    let best = null;
    for (const e of state.entries) {
      if (e.exId !== exId || e.date >= date) continue;
      if (!best || byDateThenTs(e, best) > 0) best = e;
    }
    return best;
  }
  function entryOn(state, exId, date) {
    let best = null;
    for (const e of state.entries) {
      if (e.exId === exId && e.date === date && (!best || (e.ts || 0) > (best.ts || 0))) best = e;
    }
    return best;
  }
  function dayOf(state, exId) {
    return state.days.find((d) => d.exIds.includes(exId)) || null;
  }
  function dayLastDone(state, day) {
    const ids = new Set(day.exIds);
    let last = null;
    for (const e of state.entries) if (ids.has(e.exId) && (!last || e.date > last)) last = e.date;
    return last;
  }
  /** The day you did longest ago (days with no exercises are skipped). */
  function upNextDayId(state) {
    let pick = null, pickLast = null;
    for (const day of state.days) {
      if (!day.exIds.length) continue;
      const last = dayLastDone(state, day) || '';
      if (pick === null || last < pickLast) { pick = day.id; pickLast = last; }
    }
    return pick;
  }

  /**
   * Progression nudge, based on the last session.
   *  up:   hit every set and rep -> add one weight step (assisted machines: remove one step)
   *  reps: hit everything at bodyweight / zero assistance -> add a rep
   *  hold: missed reps -> repeat the same weight
   */
  function suggest(ex, last) {
    if (!last) return null;
    if (!last.hit) return { kind: 'hold', weight: last.weight, sets: last.sets, reps: last.reps };
    const inc = ex && ex.inc > 0 ? ex.inc : 5;
    if (ex && ex.assisted) {
      if (last.weight <= 0) return { kind: 'reps', weight: 0, sets: last.sets, reps: last.reps + 1 };
      return { kind: 'up', weight: Math.max(0, round2(last.weight - inc)), sets: last.sets, reps: last.reps };
    }
    if (last.weight <= 0) return { kind: 'reps', weight: 0, sets: last.sets, reps: last.reps + 1 };
    return { kind: 'up', weight: round2(last.weight + inc), sets: last.sets, reps: last.reps };
  }

  function exerciseStats(state, exId) {
    const ex = state.exercises[exId];
    const list = entriesFor(state, exId);
    if (!list.length) return { count: 0 };
    const weights = list.map((e) => e.weight);
    const best = ex && ex.assisted ? Math.min(...weights) : Math.max(...weights);
    const first = list[0], latest = list[list.length - 1];
    return { count: list.length, best, first, latest, change: round2(latest.weight - first.weight) };
  }

  // ---------- mutations (mutate the state passed in) ----------
  function addDay(state, name) {
    const day = { id: uid(), name: String(name || '').trim() || 'New day', exIds: [] };
    state.days.push(day);
    return day;
  }
  function renameDay(state, dayId, name) {
    const d = state.days.find((x) => x.id === dayId);
    if (d && String(name).trim()) d.name = String(name).trim();
    return d;
  }
  function moveInArray(arr, idx, delta) {
    const j = idx + delta;
    if (idx < 0 || j < 0 || j >= arr.length) return false;
    const [item] = arr.splice(idx, 1);
    arr.splice(j, 0, item);
    return true;
  }
  function moveDay(state, dayId, delta) {
    return moveInArray(state.days, state.days.findIndex((d) => d.id === dayId), delta);
  }
  function deleteDay(state, dayId) {
    const d = state.days.find((x) => x.id === dayId);
    if (!d) return;
    for (const exId of d.exIds.slice()) deleteExercise(state, exId);
    state.days = state.days.filter((x) => x.id !== dayId);
  }
  function addExercise(state, dayId, fields) {
    const day = state.days.find((d) => d.id === dayId);
    if (!day) throw new Error('Unknown day');
    const ex = makeExercise(fields || {});
    state.exercises[ex.id] = ex;
    day.exIds.push(ex.id);
    return ex;
  }
  function updateExercise(state, exId, fields, newDayId) {
    const old = state.exercises[exId];
    if (!old) return null;
    const ex = makeExercise(Object.assign({}, old, fields, { id: exId }));
    state.exercises[exId] = ex;
    if (newDayId) {
      const from = dayOf(state, exId);
      const to = state.days.find((d) => d.id === newDayId);
      if (to && from && from.id !== to.id) {
        from.exIds = from.exIds.filter((id) => id !== exId);
        to.exIds.push(exId);
      }
    }
    return ex;
  }
  function moveExercise(state, exId, delta) {
    const d = dayOf(state, exId);
    return d ? moveInArray(d.exIds, d.exIds.indexOf(exId), delta) : false;
  }
  function deleteExercise(state, exId) {
    for (const d of state.days) d.exIds = d.exIds.filter((id) => id !== exId);
    delete state.exercises[exId];
    state.entries = state.entries.filter((e) => e.exId !== exId);
  }
  /** Insert or update an entry (same id = update). Returns the stored entry. */
  function saveEntry(state, fields) {
    if (!state.exercises[fields.exId]) throw new Error('Unknown exercise');
    if (!isValidISO(fields.date)) throw new Error('Bad date');
    const weight = Number(fields.weight);
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Bad weight');
    const entry = {
      id: fields.id || uid(),
      exId: fields.exId,
      date: fields.date,
      weight: round2(weight),
      sets: toPosInt(fields.sets, 1),
      reps: toPosInt(fields.reps, 1),
      hit: fields.hit !== false,
      note: String(fields.note || '').trim(),
      ts: fields.ts || Date.now()
    };
    const i = state.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) state.entries[i] = entry; else state.entries.push(entry);
    return entry;
  }
  function deleteEntry(state, entryId) {
    state.entries = state.entries.filter((e) => e.id !== entryId);
  }

  // ---------- validation / import ----------
  /** Validates anything that claims to be a Gym Log state and returns a clean copy. Throws if unusable. */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.days) || !Array.isArray(raw.entries)) {
      throw new Error('This file is not a Gym Log backup.');
    }
    const s = emptyState();
    s.unit = raw.unit === 'kg' ? 'kg' : 'lb';
    s.rest = Number(raw.rest) >= 10 && Number(raw.rest) <= 900 ? Math.round(raw.rest) : 90;
    s.showTimer = raw.showTimer !== false;
    s.lastBackup = typeof raw.lastBackup === 'string' && isValidISO(raw.lastBackup) ? raw.lastBackup : null;
    s.created = Number(raw.created) || Date.now();
    s.savedAt = Number(raw.savedAt) || 0;

    const rawEx = Array.isArray(raw.exercises) ? raw.exercises
      : (raw.exercises && typeof raw.exercises === 'object' ? Object.values(raw.exercises) : []);
    for (const e of rawEx) {
      if (!e || typeof e !== 'object' || !String(e.name || '').trim()) continue;
      const ex = makeExercise(e);
      if (s.exercises[ex.id]) ex.id = uid();
      s.exercises[ex.id] = ex;
    }
    const placed = new Set();
    for (const d of raw.days) {
      if (!d || typeof d !== 'object') continue;
      const day = { id: d.id ? String(d.id) : uid(), name: String(d.name || '').trim() || 'Day', exIds: [] };
      if (s.days.some((x) => x.id === day.id)) day.id = uid();
      for (const id of Array.isArray(d.exIds) ? d.exIds : []) {
        if (s.exercises[id] && !placed.has(id)) { day.exIds.push(id); placed.add(id); }
      }
      s.days.push(day);
    }
    const orphans = Object.keys(s.exercises).filter((id) => !placed.has(id));
    if (orphans.length) s.days.push({ id: uid(), name: 'Other', exIds: orphans });

    const seen = new Set();
    for (const e of raw.entries) {
      if (!e || typeof e !== 'object' || !s.exercises[e.exId] || !isValidISO(e.date)) continue;
      const w = Number(e.weight), sets = Math.round(Number(e.sets)), reps = Math.round(Number(e.reps));
      if (!Number.isFinite(w) || w < 0 || !(sets >= 1) || !(reps >= 1)) continue;
      let id = e.id ? String(e.id) : uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      s.entries.push({
        id, exId: e.exId, date: e.date, weight: round2(w), sets: Math.min(sets, 999), reps: Math.min(reps, 999),
        hit: e.hit !== false, note: String(e.note || '').trim(), ts: Number(e.ts) || 0
      });
    }
    return s;
  }

  function entryKey(exId, e) {
    return [exId, e.date, round2(e.weight), e.sets, e.reps].join('|');
  }
  /**
   * Merge an imported log into the current one without creating duplicates.
   * Days match by name; exercises match by name (same day first, then any day).
   * Returns a NEW state plus counts.
   */
  function mergeState(current, incoming) {
    const s = clone(current);
    const inc = normalizeState(incoming);
    const res = { added: 0, duplicates: 0, newDays: 0, newExercises: 0 };
    const existingKeys = new Set(s.entries.map((e) => entryKey(e.exId, e)));
    const exMap = {};
    for (const d of inc.days) {
      let day = s.days.find((x) => norm(x.name) === norm(d.name));
      if (!day) { day = addDay(s, d.name); res.newDays++; }
      for (const exId of d.exIds) {
        const iex = inc.exercises[exId];
        let id = day.exIds.find((id2) => norm(s.exercises[id2].name) === norm(iex.name));
        if (!id) id = Object.keys(s.exercises).find((id2) => norm(s.exercises[id2].name) === norm(iex.name));
        if (!id) {
          const ex = addExercise(s, day.id, Object.assign({}, iex, { id: undefined }));
          id = ex.id;
          res.newExercises++;
        }
        exMap[exId] = id;
      }
    }
    for (const e of inc.entries) {
      const exId = exMap[e.exId];
      if (!exId) continue;
      const key = entryKey(exId, e);
      if (existingKeys.has(key)) { res.duplicates++; continue; }
      existingKeys.add(key);
      s.entries.push(Object.assign({}, e, { id: uid(), exId }));
      res.added++;
    }
    return { state: s, result: res };
  }

  // ---------- CSV ----------
  const CSV_COLUMNS = ['date', 'day', 'exercise', 'weight', 'unit', 'sets', 'reps', 'all_reps_hit', 'exercise_note', 'entry_note'];

  function csvCell(v, isText) {
    let s = v == null ? '' : String(v);
    // Spreadsheet apps treat a leading = + - @ as a formula ("+ bar" would break). Guard with an apostrophe.
    if (isText && /^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCSV(state) {
    const dayIndex = {}, exIndex = {}, dayName = {};
    state.days.forEach((d, i) => d.exIds.forEach((id, j) => { dayIndex[id] = i; exIndex[id] = j; dayName[id] = d.name; }));
    const rows = state.entries.slice().sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 :
        (dayIndex[a.exId] - dayIndex[b.exId]) || (exIndex[a.exId] - exIndex[b.exId]) || ((a.ts || 0) - (b.ts || 0)));
    const lines = [CSV_COLUMNS.join(',')];
    for (const e of rows) {
      const ex = state.exercises[e.exId];
      if (!ex) continue;
      lines.push([
        e.date, csvCell(dayName[e.exId] || '', true), csvCell(ex.name, true), fmtNum(e.weight), state.unit,
        e.sets, e.reps, e.hit ? 'yes' : 'no', csvCell(ex.note, true), csvCell(e.note, true)
      ].join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }
  /** RFC 4180 parser: quotes, escaped quotes, commas and newlines inside quotes, CRLF, BOM. */
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
  }
  function parseDateLoose(s) {
    s = String(s || '').trim();
    if (isValidISO(s)) return s;
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);       // 10/19/2026 (US)
    if (m) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const iso = y + '-' + pad(m[1]) + '-' + pad(m[2]);
      return isValidISO(iso) ? iso : null;
    }
    m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (m) { const iso = m[1] + '-' + pad(m[2]) + '-' + pad(m[3]); return isValidISO(iso) ? iso : null; }
    return null;
  }
  function parseBool(s, dflt) {
    const v = norm(s);
    if (['yes', 'y', 'true', '1', '✓'].includes(v)) return true;
    if (['no', 'n', 'false', '0', '✗'].includes(v)) return false;
    return dflt;
  }
  function unguard(s) { s = String(s == null ? '' : s); return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }

  /** Turns a CSV export (or a hand-made sheet with the same headers) into a state for mergeState. */
  function csvToState(text) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('The CSV file is empty.');
    const head = rows[0].map((h) => norm(h).replace(/[^a-z_]/g, ''));
    const col = (name) => head.indexOf(name);
    const need = ['date', 'exercise', 'weight', 'sets', 'reps'];
    const missing = need.filter((n) => col(n) < 0);
    if (missing.length) throw new Error('The CSV is missing columns: ' + missing.join(', ') + '.');
    const s = emptyState();
    let skipped = 0, ts = 1;
    const get = (r, name) => (col(name) >= 0 ? r[col(name)] : '');
    for (const r of rows.slice(1)) {
      const date = parseDateLoose(get(r, 'date'));
      const name = unguard(get(r, 'exercise')).trim();
      const weight = Number(String(get(r, 'weight')).replace(/[^\d.\-]/g, ''));
      const sets = Math.round(Number(get(r, 'sets'))), reps = Math.round(Number(get(r, 'reps')));
      if (!date || !name || !Number.isFinite(weight) || weight < 0 || !(sets >= 1) || !(reps >= 1) ||
        String(get(r, 'weight')).trim() === '') { skipped++; continue; }
      const dayName = unguard(get(r, 'day')).trim() || 'Imported';
      let day = s.days.find((d) => norm(d.name) === norm(dayName));
      if (!day) day = addDay(s, dayName);
      let exId = day.exIds.find((id) => norm(s.exercises[id].name) === norm(name));
      if (!exId) exId = addExercise(s, day.id, { name, note: unguard(get(r, 'exercise_note')).trim(), sets, reps }).id;
      s.entries.push({
        id: uid(), exId, date, weight: round2(weight), sets, reps,
        hit: parseBool(get(r, 'all_reps_hit'), true), note: unguard(get(r, 'entry_note')).trim(), ts: ts++
      });
    }
    return { state: s, skipped };
  }

  function exportJSON(state) {
    const out = clone(state);
    out.exportedAt = new Date().toISOString();
    return JSON.stringify(out, null, 2);
  }

  const api = {
    SCHEMA, uid, todayISO, isoToDate, isValidISO, daysBetween, fmtDate, fmtShort, fmtNum, round2, clone,
    emptyState, seedData, makeExercise,
    entriesFor, lastBefore, entryOn, dayOf, dayLastDone, upNextDayId, suggest, exerciseStats,
    addDay, renameDay, moveDay, deleteDay, addExercise, updateExercise, moveExercise, deleteExercise,
    saveEntry, deleteEntry,
    normalizeState, mergeState, toCSV, parseCSV, csvToState, parseDateLoose, exportJSON, CSV_COLUMNS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GymLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
