/* Gym Log: UI, storage, rest timer, service worker wiring. Data rules live in logic.js. */
(function () {
  'use strict';

  const L = window.GymLogic;
  const APP_VERSION = '1.0.0';
  const LS_KEY = 'gymlog-state';
  const LS_UI = 'gymlog-ui';

  const view = document.getElementById('view');
  const dock = document.getElementById('dock');
  const sheetRoot = document.getElementById('sheet-root');
  const toastEl = document.getElementById('toast');

  let state = null;
  let route = { name: 'home' };
  let session = null;            // the workout being logged: {dayId, date, drafts, editing, notesOpen}
  let swWaiting = null;
  let wantReload = false;
  let persisted = null;

  const fmtW = (n) => L.fmtNum(n);
  const today = () => L.todayISO();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  // ---------- icons ----------
  const PATHS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    chart: '<path d="M4 19h16"/><path d="M5 15l4.5-5 4 3.5L19 6"/>',
    dumbbell: '<path d="M2.5 10v4M5.5 7v10M18.5 7v10M21.5 10v4M5.5 12h13"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    box: '<path d="M3.5 7.5h17v4h-17z"/><path d="M5.5 11.5V19h13v-7.5M10 15h4"/>',
    cal: '<rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'
  };
  const icon = (n) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PATHS[n] + '</svg>';

  // ---------- storage: IndexedDB first, localStorage mirror ----------
  const Store = {
    dbp: null,
    chain: Promise.resolve(),
    db() {
      if (!this.dbp) {
        this.dbp = new Promise((resolve, reject) => {
          if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
          const req = indexedDB.open('gymlog', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('IndexedDB blocked'));
        });
      }
      return this.dbp;
    },
    async idbGet() {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const r = db.transaction('kv', 'readonly').objectStore('kv').get('state');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async idbPut(str) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(str, 'state');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async load() {
      const found = [];
      try {
        const v = await Promise.race([this.idbGet(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
        if (v) found.push(v);
      } catch (e) { console.warn('IndexedDB read failed, using localStorage', e); }
      try { const v = localStorage.getItem(LS_KEY); if (v) found.push(v); } catch (e) { /* private mode */ }
      let best = null;
      for (const str of found) {
        try {
          const s = L.normalizeState(JSON.parse(str));
          if (!best || s.savedAt > best.savedAt) best = s;
        } catch (e) {
          try { localStorage.setItem('gymlog-unreadable-' + Date.now(), str); } catch (e2) { /* ignore */ }
        }
      }
      return best;
    },
    save(s) {
      s.savedAt = Date.now();
      const str = JSON.stringify(s);
      try { localStorage.setItem(LS_KEY, str); } catch (e) { /* quota: IndexedDB still has it */ }
      this.chain = this.chain.then(() => this.idbPut(str)).catch((e) => console.warn('IndexedDB write failed', e));
      return this.chain;
    }
  };
  const commit = () => Store.save(state);

  function uiPref(key, val) {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(LS_UI) || '{}'); } catch (e) { /* ignore */ }
    if (val === undefined) return o[key];
    o[key] = val;
    try { localStorage.setItem(LS_UI, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }

  // ---------- routing ----------
  function parseHash() {
    const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    switch (p[0]) {
      case 'log': return { name: 'log', dayId: p[1] };
      case 'history': return { name: 'history' };
      case 'ex': return { name: 'ex', exId: p[1] };
      case 'plan': return p[1] ? { name: 'planDay', dayId: p[1] } : { name: 'plan' };
      case 'data': return { name: 'data' };
      default: return { name: 'home' };
    }
  }
  function go(hash) {
    if (location.hash === hash || (hash === '#/' && !location.hash)) render(true);
    else location.hash = hash;
  }
  window.addEventListener('hashchange', () => { closeSheet(); render(true); });

  function render(toTop) {
    route = parseHash();
    const r = {
      home: renderHome, log: renderLog, history: renderHistory, ex: renderExercise,
      plan: renderPlan, planDay: renderPlanDay, data: renderData
    }[route.name];
    view.innerHTML = r() || '';
    renderDock();
    if (toTop) window.scrollTo(0, 0);
  }

  // ---------- home ----------
  function relDay(iso) {
    const n = L.daysBetween(iso, today());
    if (n === 0) return 'today';
    if (n === 1) return 'yesterday';
    return L.fmtDate(iso);
  }
  function renderHome() {
    const t = today();
    const longDate = L.isoToDate(t).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    let html = '<header class="page-head"><h1>' + esc(longDate) + '</h1></header>';

    if (isIOS && !isStandalone() && !uiPref('installHidden')) {
      html += '<div class="notice"><p><b>Install before you log.</b> In Safari, tap the ••• button, then Share, then Add to Home Screen. ' +
        'The installed app keeps its own copy of your data, so anything logged in a Safari tab stays in Safari.</p>' +
        '<div class="notice-actions"><button class="btn" data-act="hide-install">Got it</button></div></div>';
    }
    const since = state.lastBackup || L.todayISO(new Date(state.created));
    const newSince = state.entries.some((e) => e.date > since);
    if (newSince && L.daysBetween(since, t) >= 14) {
      html += '<div class="notice"><p>' + (state.lastBackup ? 'Last backup was ' + L.daysBetween(since, t) + ' days ago.' : 'You haven’t backed up yet.') +
        ' Your log lives only on this phone.</p><div class="notice-actions"><button class="btn btn-primary" data-act="export-json">Back up now</button></div></div>';
    }
    if (!state.days.length) {
      return html + '<div class="empty"><p>No workout days yet. Add one, like Push, Pull or Legs.</p>' +
        '<button class="btn btn-primary btn-lg" data-act="add-day">Add a workout day</button></div>';
    }
    const next = L.upNextDayId(state);
    html += '<ul class="days">';
    for (const d of state.days) {
      const last = L.dayLastDone(state, d);
      const doneToday = d.exIds.filter((id) => L.entryOn(state, id, t)).length;
      let pill = '';
      if (doneToday && doneToday >= d.exIds.length) pill = '<span class="pill pill-done">Done today</span>';
      else if (doneToday) pill = '<span class="pill pill-done">' + doneToday + ' of ' + d.exIds.length + ' today</span>';
      else if (d.id === next) pill = '<span class="pill pill-next">Up next</span>';
      const meta = plural(d.exIds.length, 'exercise') + (last ? ', last done ' + relDay(last) : ', not done yet');
      html += '<li><button class="day-row" data-go="#/log/' + d.id + '"><span class="grow"><span class="name">' + esc(d.name) +
        '</span><span class="meta">' + esc(meta) + '</span></span>' + pill + '<span class="chev">' + icon('chev') + '</span></button></li>';
    }
    return html + '</ul>';
  }

  // ---------- log a workout ----------
  function ensureSession(dayId) {
    if (!session || session.dayId !== dayId) {
      session = { dayId, date: today(), drafts: {}, editing: {}, notesOpen: {} };
    }
  }
  function draftFor(exId) {
    if (!session.drafts[exId]) {
      const ex = state.exercises[exId];
      const on = L.entryOn(state, exId, session.date);
      const last = L.lastBefore(state, exId, session.date);
      const src = on || last;
      session.drafts[exId] = src
        ? { weight: src.weight, sets: src.sets, reps: src.reps, hit: on ? on.hit : true, note: on ? on.note : '' }
        : { weight: 0, sets: ex.sets, reps: ex.reps, hit: true, note: '' };
    }
    return session.drafts[exId];
  }
  const wLabel = (ex, w) => fmtW(w) + ' ' + state.unit + (ex.note ? ' ' + ex.note : '');

  function nudgeHTML(exId) {
    const ex = state.exercises[exId];
    const last = L.lastBefore(state, exId, session.date);
    const s = L.suggest(ex, last);
    const d = draftFor(exId);
    if (!s || session.editing[exId]) return '';
    const u = state.unit;
    if (s.kind === 'hold') {
      return '<div class="nudge hold"><span>You missed reps last time. Stay at ' + esc(fmtW(last.weight)) + ' ' + u +
        ' until you get all ' + last.sets + '×' + last.reps + '.</span></div>';
    }
    if (s.kind === 'reps') {
      if (d.reps >= s.reps) return '<div class="nudge applied"><span>One more rep than last time.</span></div>';
      return '<div class="nudge"><span>You hit every rep last time. Try ' + s.reps + ' reps.</span>' +
        '<button class="btn btn-yellow" data-act="use-sug" data-ex="' + exId + '">Use ' + s.reps + '</button></div>';
    }
    const diff = L.round2(ex.assisted ? last.weight - d.weight : d.weight - last.weight);
    if (diff > 0) {
      return '<div class="nudge applied"><span>' + (ex.assisted ? fmtW(diff) + ' ' + u + ' less assistance than last time.'
        : 'Up ' + fmtW(diff) + ' ' + u + ' from last time.') + '</span></div>';
    }
    return '<div class="nudge"><span>You hit every rep last time. Try ' + esc(fmtW(s.weight)) + ' ' + u + '.</span>' +
      '<button class="btn btn-yellow" data-act="use-sug" data-ex="' + exId + '">Use ' + esc(fmtW(s.weight)) + '</button></div>';
  }
  function primaryLabel(exId) {
    const d = draftFor(exId);
    if (session.editing[exId]) return 'Save changes';
    const last = L.lastBefore(state, exId, session.date);
    if (last && d.weight === last.weight && d.sets === last.sets && d.reps === last.reps) return 'Same as last time';
    return 'Log ' + fmtW(d.weight) + ' ' + state.unit + ', ' + d.sets + '×' + d.reps;
  }
  const noteChip = (d) => (d.note ? 'Note: ' + (d.note.length > 14 ? d.note.slice(0, 13) + '…' : d.note) : 'Add note');

  function stationHTML(exId, extraClass) {
    const ex = state.exercises[exId];
    const on = L.entryOn(state, exId, session.date);
    const u = state.unit;
    const cls = extraClass ? ' ' + extraClass : '';
    if (on && !session.editing[exId]) {
      return '<section class="station logged' + cls + '" id="st-' + exId + '">' +
        '<div class="logged-row"><span class="disc">' + icon('check') + '</span><div class="what"><h2>' + esc(ex.name) + '</h2>' +
        '<div class="result' + (on.hit ? '' : ' missed') + '">' + esc(fmtW(on.weight)) + ' <small>' + u + (ex.note ? ' ' + esc(ex.note) : '') +
        '</small> ' + on.sets + '×' + on.reps + (on.hit ? '' : ' <small>missed reps</small>') + '</div></div>' +
        '<button class="link-btn" data-act="edit-logged" data-ex="' + exId + '">Edit</button>' +
        '<button class="link-btn" data-act="undo" data-ex="' + exId + '">Undo</button></div></section>';
    }
    const d = draftFor(exId);
    const last = L.lastBefore(state, exId, session.date);
    const lastLine = last
      ? 'Last time <b>' + esc(wLabel(ex, last.weight)) + ', ' + last.sets + '×' + last.reps + '</b>' +
        (last.hit ? '' : ' (missed reps)') + ' on ' + esc(L.fmtDate(last.date))
      : (session.editing[exId] ? 'Editing what you logged on ' + esc(L.fmtShort(session.date)) + '.' : 'First time. Set the weight, then log it.');
    const mini = (field, label) =>
      '<div class="stepper"><button class="step" data-act="' + field + '-" data-ex="' + exId + '" aria-label="Fewer ' + label + '">' + icon('minus') + '</button>' +
      '<label class="val"><input class="num" type="text" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" data-field="' + field + '" data-ex="' + exId +
      '" value="' + d[field] + '" aria-label="' + label + '"><span class="unit">' + label + '</span></label>' +
      '<button class="step" data-act="' + field + '+" data-ex="' + exId + '" aria-label="More ' + label + '">' + icon('plus') + '</button></div>';
    return '<section class="station' + cls + '" id="st-' + exId + '">' +
      '<div class="ex-head"><h2>' + esc(ex.name) + '</h2><button class="icon-btn" data-go="#/ex/' + exId + '" aria-label="History for ' + esc(ex.name) + '">' + icon('chart') + '</button></div>' +
      '<p class="last">' + lastLine + '</p>' +
      '<div class="nudge-slot">' + nudgeHTML(exId) + '</div>' +
      '<div class="stepper"><button class="step" data-act="w-" data-ex="' + exId + '" aria-label="Less weight">' + icon('minus') + '</button>' +
      '<label class="val"><input class="num" type="text" inputmode="decimal" enterkeyhint="done" data-field="weight" data-ex="' + exId + '" value="' + esc(fmtW(d.weight)) +
      '" aria-label="Weight in ' + u + '"><span class="unit">' + u + (ex.note ? '<small>' + esc(ex.note) + '</small>' : '') + '</span></label>' +
      '<button class="step" data-act="w+" data-ex="' + exId + '" aria-label="More weight">' + icon('plus') + '</button></div>' +
      '<div class="sr">' + mini('sets', 'sets') + mini('reps', 'reps') + '</div>' +
      '<button class="btn btn-primary btn-block btn-lg primary" data-act="log" data-ex="' + exId + '">' + icon('check') +
      '<span class="plabel">' + esc(primaryLabel(exId)) + '</span></button>' +
      '<div class="toggles"><button class="toggle-chip" data-act="hit" data-ex="' + exId + '" aria-pressed="' + (!d.hit) + '">Missed reps</button>' +
      '<button class="toggle-chip' + (d.note ? ' has-note' : '') + '" data-act="note" data-ex="' + exId + '">' + esc(noteChip(d)) + '</button>' +
      (session.editing[exId] ? '<button class="toggle-chip" data-act="cancel-edit" data-ex="' + exId + '">Cancel</button>' : '') + '</div>' +
      (session.notesOpen[exId] ? '<input class="note-input" type="text" data-field="note" data-ex="' + exId + '" enterkeyhint="done" placeholder="Note for this session" value="' + esc(d.note) + '">' : '') +
      '</section>';
  }
  function progressText(day) {
    const n = day.exIds.filter((id) => L.entryOn(state, id, session.date)).length;
    return n + ' of ' + day.exIds.length + ' logged';
  }
  function renderLog() {
    const day = state.days.find((d) => d.id === route.dayId);
    if (!day) { setTimeout(() => go('#/'), 0); return ''; }
    ensureSession(day.id);
    const t = today();
    const dateLabel = session.date === t ? 'Today, ' + L.fmtShort(t) : L.fmtDate(session.date);
    return '<header class="top"><button class="icon-btn" data-go="#/" aria-label="Back to workouts">' + icon('back') + '</button>' +
      '<h1>' + esc(day.name) + '</h1></header>' +
      '<div class="log-meta"><div class="date-pick"><span class="btn" aria-hidden="true">' + icon('cal') + esc(dateLabel) + '</span>' +
      '<input type="date" id="log-date" value="' + session.date + '" aria-label="Workout date"></div>' +
      '<span class="progress" id="progress">' + progressText(day) + '</span></div>' +
      (day.exIds.length ? day.exIds.map((id) => stationHTML(id)).join('') : '<div class="empty"><p>No exercises in ' + esc(day.name) + ' yet.</p></div>') +
      '<div class="log-foot"><button class="btn btn-block" data-act="add-ex" data-day="' + day.id + '">' + icon('plus') + 'Add exercise</button>' +
      '<button class="btn btn-primary btn-block btn-lg" data-act="finish">Finish workout</button></div>';
  }
  function refreshStation(exId, extraClass) {
    const el = document.getElementById('st-' + exId);
    if (el) el.outerHTML = stationHTML(exId, extraClass);
    const day = state.days.find((d) => d.id === session.dayId);
    const p = document.getElementById('progress');
    if (p && day) p.textContent = progressText(day);
  }
  function refreshBits(exId) {
    const st = document.getElementById('st-' + exId);
    if (!st) return;
    const slot = st.querySelector('.nudge-slot');
    if (slot) slot.innerHTML = nudgeHTML(exId);
    const pl = st.querySelector('.plabel');
    if (pl) pl.textContent = primaryLabel(exId);
    const nc = st.querySelector('[data-act="note"]');
    if (nc) { const d = draftFor(exId); nc.textContent = noteChip(d); nc.classList.toggle('has-note', !!d.note); }
  }
  function readInputs(exId) {
    const st = document.getElementById('st-' + exId);
    if (!st) return;
    const d = draftFor(exId);
    st.querySelectorAll('[data-field]').forEach((el) => applyField(d, el.dataset.field, el.value));
  }
  function applyField(d, field, raw) {
    if (field === 'note') { d.note = String(raw).trim(); return; }
    const v = parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0) return;
    if (field === 'weight') d.weight = L.round2(Math.min(v, 9999));
    else d[field] = Math.min(99, Math.max(1, Math.round(v)));
  }

  function logExercise(exId) {
    readInputs(exId);
    const d = draftFor(exId);
    const on = L.entryOn(state, exId, session.date);
    L.saveEntry(state, {
      id: on ? on.id : undefined, exId, date: session.date, weight: d.weight, sets: d.sets, reps: d.reps,
      hit: d.hit, note: d.note, ts: on ? on.ts : Date.now()
    });
    commit();
    session.editing[exId] = false;
    session.notesOpen[exId] = false;
    refreshStation(exId, 'just-logged');
    const day = state.days.find((x) => x.id === session.dayId);
    if (day && day.exIds.every((id) => L.entryOn(state, id, session.date)) && !on) {
      toast(day.name + ' done. All ' + plural(day.exIds.length, 'exercise') + ' logged.');
    }
  }

  // ---------- rest timer ----------
  const mmss = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const Rest = {
    end: 0, doneAt: 0, timer: null, ctx: null, wake: null,
    start(sec) {
      this.unlockAudio();
      this.end = Date.now() + sec * 1000;
      this.doneAt = 0;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.update(), 250);
      this.keepAwake();
      renderDock();
    },
    add(sec) { if (this.end) { this.end += sec * 1000; this.update(); } },
    stop() { clearInterval(this.timer); this.end = 0; this.doneAt = 0; this.release(); renderDock(); },
    remaining() { return Math.max(0, Math.ceil((this.end - Date.now()) / 1000)); },
    update() {
      if (!this.end) return;
      const r = this.remaining();
      const el = document.getElementById('rest-clock');
      if (el) el.textContent = mmss(r);
      if (r <= 0) this.finish();
    },
    finish() {
      clearInterval(this.timer);
      this.end = 0;
      this.doneAt = Date.now();
      this.beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      this.release();
      renderDock();
      setTimeout(() => { if (this.doneAt && Date.now() - this.doneAt >= 5000) { this.doneAt = 0; renderDock(); } }, 5100);
    },
    unlockAudio() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) this.ctx = new AC();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const b = this.ctx.createBuffer(1, 1, 22050);       // silent blip unlocks audio on iOS
        const src = this.ctx.createBufferSource();
        src.buffer = b; src.connect(this.ctx.destination); src.start(0);
      } catch (e) { /* no audio */ }
    },
    beep() {
      try {
        if (!this.ctx) return;
        const t0 = this.ctx.currentTime + 0.02;
        for (let i = 0; i < 3; i++) {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain();
          o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880;
          g.gain.setValueAtTime(0.0001, t0 + i * 0.28);
          g.gain.exponentialRampToValueAtTime(0.5, t0 + i * 0.28 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.28 + 0.22);
          o.connect(g); g.connect(this.ctx.destination);
          o.start(t0 + i * 0.28); o.stop(t0 + i * 0.28 + 0.24);
        }
      } catch (e) { /* no audio */ }
    },
    async keepAwake() {
      try { if ('wakeLock' in navigator && !this.wake) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); } }
      catch (e) { this.wake = null; }
    },
    release() { try { if (this.wake) this.wake.release(); } catch (e) { /* ignore */ } this.wake = null; }
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Rest.end) { Rest.update(); if (Rest.end) Rest.keepAwake(); }
  });

  function restBarHTML() {
    if (Rest.end) {
      return '<div class="rest"><span class="clock" id="rest-clock" role="timer">' + mmss(Rest.remaining()) + '</span>' +
        '<button class="btn" data-act="rest-add">+15s</button><button class="btn" data-act="rest-stop">Stop</button></div>';
    }
    if (Rest.doneAt) {
      return '<div class="rest done"><span class="clock">Next set</span><button class="btn" data-act="rest-stop">OK</button></div>';
    }
    return '<div class="rest"><span class="label">Rest</span><div class="presets">' +
      [60, 90, 120, 180].map((s) => '<button class="btn" data-act="rest" data-sec="' + s + '">' + mmss(s) + '</button>').join('') + '</div></div>';
  }
  function tabsHTML() {
    const tab = { home: 'w', log: 'w', history: 'h', ex: 'h', plan: 'p', planDay: 'p', data: 'd' }[route.name];
    const t = (key, hash, ic, label) => '<a class="tab" href="' + hash + '"' + (tab === key ? ' aria-current="page"' : '') + '>' + icon(ic) + label + '</a>';
    return '<nav class="tabs" aria-label="Sections">' + t('w', '#/', 'dumbbell', 'Workout') + t('h', '#/history', 'chart', 'History') +
      t('p', '#/plan', 'list', 'Plan') + t('d', '#/data', 'box', 'Data') + '</nav>';
  }
  function renderDock() {
    const onLog = route.name === 'log';
    const showRest = (onLog && state.showTimer) || Rest.end || Rest.doneAt;
    const parts = [];
    if (showRest) parts.push(restBarHTML());
    if (!onLog || !state.showTimer) parts.push(tabsHTML());
    dock.innerHTML = parts.join('');
    document.documentElement.style.setProperty('--dock-rows', String(parts.length));
  }

  // ---------- history ----------
  function changeText(ex, st) {
    if (!st.count || st.count < 2 || !st.change) return '';
    const better = ex.assisted ? st.change < 0 : st.change > 0;
    const sign = st.change > 0 ? '+' : '−';
    return '<span class="' + (better ? 'up' : '') + '">' + sign + fmtW(Math.abs(st.change)) + ' since ' + L.fmtShort(st.first.date) + '</span>';
  }
  function renderHistory() {
    let html = '<header class="page-head"><h1>History</h1></header>';
    if (!state.days.some((d) => d.exIds.length)) return html + '<div class="empty"><p>Nothing logged yet.</p></div>';
    for (const d of state.days) {
      if (!d.exIds.length) continue;
      html += '<h2 class="group-title">' + esc(d.name) + '</h2><ul class="rows">';
      for (const id of d.exIds) {
        const ex = state.exercises[id];
        const st = L.exerciseStats(state, id);
        html += '<li><button class="row" data-go="#/ex/' + id + '"><span class="grow"><span class="title">' + esc(ex.name) + '</span>' +
          '<span class="sub">' + (st.count ? 'Last ' + esc(relDay(st.latest.date)) + ', ' + plural(st.count, 'session') : 'No sessions yet') + '</span></span>' +
          (st.count ? '<span class="figure"><b>' + esc(fmtW(st.latest.weight)) + '</b><span>' + state.unit + (ex.note ? ' ' + esc(ex.note) : '') + '</span>' +
            (changeText(ex, st) ? '<br><span>' + changeText(ex, st) + '</span>' : '') + '</span>' : '') +
          '</button></li>';
      }
      html += '</ul>';
    }
    return html;
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(L.round2(v));
    return ticks;
  }
  function chartSVG(list) {
    if (!list.length) return '';
    const W = 340, H = 200, pl = 38, pr = 22, pt = 26, pb = 30;
    const ws = list.map((e) => e.weight);
    let min = Math.min(...ws), max = Math.max(...ws);
    if (min === max) { min = Math.max(0, min - 10); max = max + 10; }
    else { const pad = (max - min) * 0.18; min = Math.max(0, min - pad); max += pad; }
    const t0 = L.isoToDate(list[0].date).getTime(), t1 = L.isoToDate(list[list.length - 1].date).getTime();
    const x = (e) => (t1 === t0 ? pl + (W - pl - pr) / 2 : pl + (L.isoToDate(e.date).getTime() - t0) / (t1 - t0) * (W - pl - pr));
    const y = (w) => pt + (1 - (w - min) / (max - min)) * (H - pt - pb);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Weight over time">';
    for (const v of niceTicks(min, max, 3)) {
      s += '<line class="grid" x1="' + pl + '" x2="' + (W - pr + 10) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>' +
        '<text class="tick" x="' + (pl - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + fmtW(v) + '</text>';
    }
    if (list.length > 1) {
      s += '<polyline class="line" points="' + list.map((e) => x(e).toFixed(1) + ',' + y(e.weight).toFixed(1)).join(' ') + '"/>';
    }
    list.forEach((e, i) => {
      const lastPt = i === list.length - 1;
      s += '<circle class="pt' + (e.hit ? '' : ' miss') + (lastPt ? ' latest' : '') + '" cx="' + x(e).toFixed(1) + '" cy="' + y(e.weight).toFixed(1) + '" r="' + (lastPt ? 6 : 4.5) + '"/>';
    });
    const lastE = list[list.length - 1];
    s += '<text class="val-label" x="' + Math.min(x(lastE), W - 6).toFixed(1) + '" y="' + (y(lastE.weight) - 12).toFixed(1) + '" text-anchor="end">' + fmtW(lastE.weight) + '</text>';
    s += '<text class="tick" x="' + pl + '" y="' + (H - 8) + '" text-anchor="start">' + L.fmtShort(list[0].date) + '</text>';
    if (t1 !== t0) s += '<text class="tick" x="' + (W - pr) + '" y="' + (H - 8) + '" text-anchor="end">' + L.fmtShort(lastE.date) + '</text>';
    return s + '</svg>';
  }
  function renderExercise() {
    const ex = state.exercises[route.exId];
    if (!ex) { setTimeout(() => go('#/history'), 0); return ''; }
    const list = L.entriesFor(state, ex.id);
    const st = L.exerciseStats(state, ex.id);
    const u = state.unit;
    let html = '<header class="top"><button class="icon-btn" data-act="back" data-fallback="#/history" aria-label="Back">' + icon('back') + '</button>' +
      '<span style="flex:1"></span><button class="link-btn" data-act="edit-ex" data-ex="' + ex.id + '">Edit</button></header>' +
      '<div class="section" style="padding-top:0"><h1 class="ex-title">' + esc(ex.name) + '</h1>' +
      (ex.note || ex.assisted ? '<p>' + esc([ex.note, ex.assisted ? 'Assisted: lower is harder' : ''].filter(Boolean).join('. ')) + '</p>' : '') + '</div>';
    if (st.count) {
      html += '<div class="stats"><div class="stat"><b>' + esc(fmtW(st.latest.weight)) + '</b><span>Latest, ' + u + '</span></div>' +
        '<div class="stat"><b>' + esc(fmtW(st.best)) + '</b><span>' + (ex.assisted ? 'Least assisted' : 'Best') + ', ' + u + '</span></div>' +
        '<div class="stat"><b>' + st.count + '</b><span>' + (st.count === 1 ? 'Session' : 'Sessions') + '</span></div></div>' +
        '<div class="chart">' + chartSVG(list) +
        '<p class="caption">' + (list.length < 2 ? 'Log a few more sessions to see a trend.'
          : (ex.assisted ? 'Assisted machine: the line going down means you’re lifting more of your bodyweight.'
            : 'Weight per session. Hollow dots are sessions with missed reps.')) + '</p></div>';
    }
    html += '<h2 class="group-title">Sessions</h2>';
    if (!list.length) html += '<div class="empty"><p>No sessions logged yet.</p></div>';
    else {
      html += '<ul class="rows">';
      for (const e of list.slice().reverse()) {
        html += '<li><button class="row entry-row" data-act="edit-entry" data-ex="' + ex.id + '" data-entry="' + e.id + '"><span class="grow">' +
          '<span class="title">' + esc(fmtW(e.weight)) + ' <small>' + u + (ex.note ? ' ' + esc(ex.note) : '') + '</small></span>' +
          '<span class="sub">' + e.sets + '×' + e.reps + ' on ' + esc(L.fmtDate(e.date)) + (e.hit ? '' : ', <span class="miss">missed reps</span>') +
          (e.note ? '. ' + esc(e.note) : '') + '</span></span><span class="chev">' + icon('chev') + '</span></button></li>';
      }
      html += '</ul>';
    }
    return html + '<div class="section stack"><button class="btn btn-block" data-act="add-entry" data-ex="' + ex.id + '">' + icon('plus') + 'Add a past session</button></div>';
  }

  // ---------- plan ----------
  function orderBtns(act, id, i, n) {
    return '<span class="order"><button class="icon-btn" data-act="' + act + '-up" data-id="' + id + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + icon('up') + '</button>' +
      '<button class="icon-btn" data-act="' + act + '-down" data-id="' + id + '" aria-label="Move down"' + (i === n - 1 ? ' disabled' : '') + '>' + icon('down') + '</button></span>';
  }
  function renderPlan() {
    let html = '<header class="page-head"><h1>Plan</h1><p>Your workout days and what goes in each.</p></header><ul class="rows">';
    state.days.forEach((d, i) => {
      html += '<li class="row"><button class="tap" data-go="#/plan/' + d.id + '"><span class="title">' + esc(d.name) + '</span>' +
        '<span class="sub">' + plural(d.exIds.length, 'exercise') + '</span></button>' + orderBtns('day', d.id, i, state.days.length) + '</li>';
    });
    return html + '</ul><div class="section stack"><button class="btn btn-primary btn-block btn-lg" data-act="add-day">' + icon('plus') + 'Add workout day</button></div>';
  }
  function renderPlanDay() {
    const day = state.days.find((d) => d.id === route.dayId);
    if (!day) { setTimeout(() => go('#/plan'), 0); return ''; }
    let html = '<header class="top"><button class="icon-btn" data-go="#/plan" aria-label="Back to plan">' + icon('back') + '</button>' +
      '<h1>' + esc(day.name) + '</h1><button class="link-btn" data-act="rename-day" data-id="' + day.id + '">Rename</button></header>';
    if (!day.exIds.length) html += '<div class="empty"><p>No exercises yet. Add the first one.</p></div>';
    html += '<ul class="rows">';
    day.exIds.forEach((id, i) => {
      const ex = state.exercises[id];
      const bits = [ex.note, 'step ' + fmtW(ex.inc) + ' ' + state.unit, ex.assisted ? 'assisted' : ''].filter(Boolean).join(', ');
      html += '<li class="row"><button class="tap" data-act="edit-ex" data-ex="' + id + '"><span class="title">' + esc(ex.name) + '</span>' +
        '<span class="sub">' + esc(bits) + '</span></button>' + orderBtns('ex', id, i, day.exIds.length) + '</li>';
    });
    return html + '</ul><div class="section stack">' +
      '<button class="btn btn-primary btn-block btn-lg" data-act="add-ex" data-day="' + day.id + '">' + icon('plus') + 'Add exercise</button>' +
      (day.exIds.length ? '<button class="btn btn-block" data-go="#/log/' + day.id + '">Start ' + esc(day.name) + ' workout</button>' : '') +
      '<button class="btn btn-danger btn-block" data-act="delete-day" data-id="' + day.id + '">Delete ' + esc(day.name) + '</button></div>';
  }

  // ---------- data ----------
  function renderData() {
    const sessions = state.entries.length;
    const sw = 'serviceWorker' in navigator && navigator.serviceWorker.controller;
    return '<header class="page-head"><h1>Data</h1><p>Everything stays on this phone. Nothing is uploaded anywhere.</p></header>' +
      '<div class="section"><h2>Back up</h2>' +
      '<div class="kv"><span>Last backup</span><span>' + (state.lastBackup ? esc(L.fmtDate(state.lastBackup)) : 'Never') + '</span></div>' +
      '<div class="kv"><span>Logged sessions</span><span>' + sessions + '</span></div>' +
      '<p style="margin-top:12px">The JSON backup restores everything: days, exercises, notes and history. The CSV opens in Numbers or Excel.</p>' +
      '<div class="stack"><button class="btn btn-primary btn-block btn-lg" data-act="export-json">Save backup (JSON)</button>' +
      '<button class="btn btn-block" data-act="export-csv">Export spreadsheet (CSV)</button></div></div>' +
      '<div class="section"><h2>Restore</h2><p>Pick a JSON backup or a CSV export. You’ll choose whether to add it to your log or replace your log.</p>' +
      '<label class="btn btn-block" style="position:relative">Import a file<input type="file" id="import-file" accept=".json,.csv,application/json,text/csv,text/comma-separated-values,text/plain" ' +
      'style="position:absolute;inset:0;opacity:0;width:100%"></label></div>' +
      '<div class="section"><h2>Settings</h2>' +
      '<p>Units</p><div class="seg" role="group" aria-label="Units"><button data-act="unit" data-unit="lb" aria-pressed="' + (state.unit === 'lb') + '">lb</button>' +
      '<button data-act="unit" data-unit="kg" aria-pressed="' + (state.unit === 'kg') + '">kg</button></div>' +
      '<p style="margin-top:6px;font-size:13px">Changes the label only. Numbers you logged stay the same.</p>' +
      '<label class="switch"><span>Rest timer<small>Shows rest buttons at the bottom while you log.</small></span><input type="checkbox" id="timer-toggle"' + (state.showTimer ? ' checked' : '') + '></label></div>' +
      '<div class="section"><h2>This device</h2>' +
      '<div class="kv"><span>Works with no signal</span><span>' + (sw ? 'Yes' : 'After the next open') + '</span></div>' +
      '<div class="kv"><span>Running as</span><span>' + (isStandalone() ? 'Home Screen app' : 'Browser tab') + '</span></div>' +
      '<div class="kv"><span>Protected from cleanup</span><span>' + (persisted === null ? 'Unknown' : persisted ? 'Yes' : 'Not guaranteed') + '</span></div>' +
      (swWaiting ? '<div class="stack" style="margin-top:12px"><button class="btn btn-yellow btn-block" data-act="apply-update">Install update</button></div>' : '') +
      '</div><div class="section stack" style="margin-top:12px"><button class="btn btn-danger btn-block" data-act="erase">Erase all data</button>' +
      '<p style="text-align:center;margin-top:8px;font-size:13px">Gym Log ' + APP_VERSION + '</p></div>';
  }

  async function deliverFile(filename, mime, text) {
    const file = new File([text], filename, { type: mime });
    if (navigator.canShare && navigator.share) {
      let ok = false;
      try { ok = navigator.canShare({ files: [file] }); } catch (e) { ok = false; }
      if (ok) {
        try { await navigator.share({ files: [file] }); return 'shared'; }
        catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    return 'downloaded';
  }
  async function exportData(kind) {
    const t = today();
    const res = kind === 'csv'
      ? await deliverFile('gym-log-' + t + '.csv', 'text/csv', L.toCSV(state))
      : await deliverFile('gym-log-' + t + '.json', 'application/json', L.exportJSON(state));
    if (res === 'cancelled') return;
    state.lastBackup = t;
    commit();
    if (route.name === 'data' || route.name === 'home') render();
    toast(kind === 'csv' ? 'Spreadsheet exported' : 'Backup saved');
  }

  async function importFile(file) {
    let text;
    try { text = await file.text(); } catch (e) { toast('Couldn’t read that file.'); return; }
    const looksJSON = /\.json$/i.test(file.name) || /^\s*[{[]/.test(text);
    try {
      if (looksJSON) {
        let raw;
        try { raw = JSON.parse(text); } catch (e) { throw new Error('That JSON file is damaged and can’t be read.'); }
        const incoming = L.normalizeState(raw);
        const preview = L.mergeState(state, incoming);
        const lastDate = incoming.entries.reduce((m, e) => (e.date > m ? e.date : m), '');
        importSheet(
          'This backup has ' + plural(incoming.entries.length, 'session') + ' across ' + plural(incoming.days.length, 'day') +
          (lastDate ? ', the latest on ' + L.fmtDate(lastDate) : '') + '.',
          preview, incoming);
      } else {
        const { state: incoming, skipped } = L.csvToState(text);
        const preview = L.mergeState(state, incoming);
        importSheet('This spreadsheet has ' + plural(incoming.entries.length, 'session') +
          (skipped ? ' (' + plural(skipped, 'row') + ' couldn’t be read and will be skipped)' : '') + '.', preview, null);
      }
    } catch (e) {
      toast(e.message || 'That file couldn’t be imported.', null, null, 5000);
    }
  }
  function importSheet(summary, preview, replaceWith) {
    const r = preview.result;
    const addLine = r.added ? 'Adding it brings in ' + plural(r.added, 'new session') +
      (r.duplicates ? ' and skips ' + r.duplicates + ' you already have' : '') + '.'
      : 'Everything in it is already in your log.';
    const form = openSheet('<h2>Import</h2><p>' + esc(summary) + ' ' + esc(addLine) + '</p><div class="sheet-actions">' +
      '<button type="submit" class="btn btn-primary btn-lg"' + (r.added || r.newDays || r.newExercises ? '' : ' disabled') + '>Add to my log</button>' +
      (replaceWith ? '<button type="button" class="btn btn-danger" data-role="replace">Replace my log with this backup</button>' : '') +
      '<button type="button" class="btn btn-ghost" data-act="sheet-close">Cancel</button></div>', () => {
      state = preview.state;
      commit();
      closeSheet();
      session = null;
      render();
      toast('Added ' + plural(r.added, 'session'));
    });
    const rep = form.querySelector('[data-role="replace"]');
    if (rep) {
      rep.addEventListener('click', () => {
        if (!confirm('Replace everything on this phone with the backup? Your current log will be gone unless you backed it up.')) return;
        state = replaceWith;
        commit();
        closeSheet();
        session = null;
        render();
        toast('Log replaced from backup');
      });
    }
  }

  // ---------- sheets (bottom panels) ----------
  function openSheet(inner, onSubmit) {
    sheetRoot.innerHTML = '<div class="backdrop"><form class="sheet" role="dialog" aria-modal="true" novalidate><div class="grab"></div>' + inner + '</form></div>';
    const form = sheetRoot.querySelector('form');
    form.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(form); });
    sheetRoot.querySelector('.backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheet(); });
    return form;
  }
  function closeSheet() { sheetRoot.innerHTML = ''; }
  const sheetError = (form, msg) => { const el = form.querySelector('.err'); if (el) el.textContent = msg; };

  function daySheet(dayId) {
    const day = dayId ? state.days.find((d) => d.id === dayId) : null;
    const form = openSheet('<h2>' + (day ? 'Rename day' : 'New workout day') + '</h2>' +
      '<label class="field"><span>Name</span><input name="name" autocomplete="off" autocapitalize="words" placeholder="e.g. Legs" value="' + esc(day ? day.name : '') + '"></label>' +
      '<p class="err"></p><div class="sheet-actions"><button type="submit" class="btn btn-primary btn-lg">' + (day ? 'Save name' : 'Add day') + '</button>' +
      '<button type="button" class="btn btn-ghost" data-act="sheet-close">Cancel</button></div>', (f) => {
      const name = f.name.value.trim();
      if (!name) { sheetError(f, 'Give the day a name.'); return; }
      if (state.days.some((d) => d.id !== dayId && d.name.toLowerCase() === name.toLowerCase())) { sheetError(f, 'You already have a day called ' + name + '.'); return; }
      closeSheet();
      if (day) { L.renameDay(state, day.id, name); commit(); render(); toast('Renamed to ' + name); }
      else { const nd = L.addDay(state, name); commit(); go('#/plan/' + nd.id); toast(name + ' added. Now add its exercises.'); }
    });
    if (!day) setTimeout(() => form.name.focus(), 50);
  }

  function exerciseSheet(exId, dayId) {
    const ex = exId ? state.exercises[exId] : L.makeExercise({ name: '' });
    const curDay = exId ? L.dayOf(state, exId) : state.days.find((d) => d.id === dayId);
    if (!curDay) return;
    const u = state.unit;
    const dayField = state.days.length > 1
      ? '<label class="field"><span>Workout day</span><select name="day">' + state.days.map((d) =>
        '<option value="' + d.id + '"' + (d.id === curDay.id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select></label>'
      : '<input type="hidden" name="day" value="' + curDay.id + '">';
    const form = openSheet('<h2>' + (exId ? 'Edit exercise' : 'New exercise') + '</h2>' +
      '<label class="field"><span>Name</span><input name="name" autocomplete="off" autocapitalize="sentences" placeholder="e.g. Leg press" value="' + esc(ex.name) + '"></label>' +
      '<label class="field"><span>Weight note (optional)</span><input name="note" autocomplete="off" placeholder="e.g. + bar, per dumbbell, assisted" value="' + esc(ex.note) + '">' +
      '<span class="hint">Shown next to the number, for weights that aren’t a plain number.</span></label>' +
      '<div class="field-row"><label class="field"><span>Sets</span><input name="sets" inputmode="numeric" value="' + ex.sets + '"></label>' +
      '<label class="field"><span>Reps</span><input name="reps" inputmode="numeric" value="' + ex.reps + '"></label>' +
      '<label class="field"><span>Step, ' + u + '</span><input name="inc" inputmode="decimal" value="' + fmtW(ex.inc) + '"></label></div>' +
      '<p style="font-size:13px">Sets and reps are the starting point until you log it. Step is how much + and − change the weight and how big a jump the nudge suggests.</p>' +
      '<label class="switch"><span>Assisted machine<small>A lower number is harder, so the nudge suggests less assistance.</small></span><input type="checkbox" name="assisted"' + (ex.assisted ? ' checked' : '') + '></label>' +
      dayField + '<p class="err"></p><div class="sheet-actions">' +
      '<button type="submit" class="btn btn-primary btn-lg">' + (exId ? 'Save exercise' : 'Add exercise') + '</button>' +
      (exId ? '<button type="button" class="btn btn-danger" data-role="delete">Delete exercise</button>' : '') +
      '<button type="button" class="btn btn-ghost" data-act="sheet-close">Cancel</button></div>', (f) => {
      const name = f.name.value.trim();
      const inc = parseFloat(f.inc.value.replace(',', '.'));
      const sets = parseInt(f.sets.value, 10), reps = parseInt(f.reps.value, 10);
      if (!name) { sheetError(f, 'Give the exercise a name.'); return; }
      if (!(sets >= 1 && reps >= 1)) { sheetError(f, 'Sets and reps need to be 1 or more.'); return; }
      if (!(inc > 0)) { sheetError(f, 'Step needs to be more than 0.'); return; }
      const fields = { name, note: f.note.value.trim(), inc, sets, reps, assisted: f.assisted.checked };
      if (exId) L.updateExercise(state, exId, fields, f.day.value);
      else L.addExercise(state, f.day.value, fields);
      commit();
      closeSheet();
      if (session && exId) delete session.drafts[exId];
      render();
      toast(exId ? 'Exercise saved' : name + ' added');
    });
    const del = form.querySelector('[data-role="delete"]');
    if (del) {
      del.addEventListener('click', () => {
        const n = L.entriesFor(state, exId).length;
        if (!confirm('Delete ' + ex.name + (n ? ' and its ' + plural(n, 'logged session') : '') + '? This can’t be undone.')) return;
        L.deleteExercise(state, exId);
        commit();
        closeSheet();
        if (route.name === 'ex') go('#/history'); else render();
        toast('Exercise deleted');
      });
    }
    if (!exId) setTimeout(() => form.name.focus(), 50);
  }

  function entrySheet(exId, entryId) {
    const ex = state.exercises[exId];
    const existing = entryId ? state.entries.find((e) => e.id === entryId) : null;
    const last = L.lastBefore(state, exId, '9999-12-31');
    const e = existing || { date: today(), weight: last ? last.weight : 0, sets: last ? last.sets : ex.sets, reps: last ? last.reps : ex.reps, hit: true, note: '' };
    const form = openSheet('<h2>' + (existing ? 'Edit session' : 'Add a past session') + '</h2><p>' + esc(ex.name) + '</p>' +
      '<label class="field"><span>Date</span><input type="date" name="date" value="' + e.date + '"></label>' +
      '<div class="field-row"><label class="field"><span>Weight, ' + state.unit + '</span><input name="weight" inputmode="decimal" value="' + esc(fmtW(e.weight)) + '"></label>' +
      '<label class="field"><span>Sets</span><input name="sets" inputmode="numeric" value="' + e.sets + '"></label>' +
      '<label class="field"><span>Reps</span><input name="reps" inputmode="numeric" value="' + e.reps + '"></label></div>' +
      '<label class="switch"><span>Hit every set and rep</span><input type="checkbox" name="hit"' + (e.hit ? ' checked' : '') + '></label>' +
      '<label class="field"><span>Note (optional)</span><input name="note" autocomplete="off" value="' + esc(e.note) + '"></label>' +
      '<p class="err"></p><div class="sheet-actions"><button type="submit" class="btn btn-primary btn-lg">' + (existing ? 'Save session' : 'Add session') + '</button>' +
      (existing ? '<button type="button" class="btn btn-danger" data-role="delete">Delete session</button>' : '') +
      '<button type="button" class="btn btn-ghost" data-act="sheet-close">Cancel</button></div>', (f) => {
      const weight = parseFloat(f.weight.value.replace(',', '.'));
      const sets = parseInt(f.sets.value, 10), reps = parseInt(f.reps.value, 10);
      if (!L.isValidISO(f.date.value)) { sheetError(f, 'Pick a date.'); return; }
      if (!(weight >= 0)) { sheetError(f, 'Weight needs to be a number, 0 or more.'); return; }
      if (!(sets >= 1 && reps >= 1)) { sheetError(f, 'Sets and reps need to be 1 or more.'); return; }
      L.saveEntry(state, { id: existing ? existing.id : undefined, exId, date: f.date.value, weight, sets, reps, hit: f.hit.checked, note: f.note.value, ts: existing ? existing.ts : Date.now() });
      commit();
      closeSheet();
      session = null;
      render();
      toast(existing ? 'Session saved' : 'Session added');
    });
    const del = form.querySelector('[data-role="delete"]');
    if (del) {
      del.addEventListener('click', () => {
        if (!confirm('Delete this session?')) return;
        L.deleteEntry(state, existing.id);
        commit();
        closeSheet();
        session = null;
        render();
        toast('Session deleted');
      });
    }
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg, actionLabel, action, ms) {
    toastEl.innerHTML = '<div class="toast"><span>' + esc(msg) + '</span>' + (actionLabel ? '<button type="button">' + esc(actionLabel) + '</button>' : '') + '</div>';
    const b = toastEl.querySelector('button');
    if (b) b.addEventListener('click', () => { hideToast(); action(); });
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(hideToast, ms || 2600);
  }
  function hideToast() { toastEl.innerHTML = ''; }

  // ---------- events ----------
  const actions = {
    'w-': (t, id) => step(id, 'weight', -1),
    'w+': (t, id) => step(id, 'weight', 1),
    'sets-': (t, id) => step(id, 'sets', -1),
    'sets+': (t, id) => step(id, 'sets', 1),
    'reps-': (t, id) => step(id, 'reps', -1),
    'reps+': (t, id) => step(id, 'reps', 1),
    'use-sug': (t, id) => {
      const s = L.suggest(state.exercises[id], L.lastBefore(state, id, session.date));
      if (!s) return;
      const d = draftFor(id);
      d.weight = s.weight; d.sets = s.sets; d.reps = s.reps;
      refreshStation(id);
    },
    hit: (t, id) => { readInputs(id); const d = draftFor(id); d.hit = !d.hit; refreshStation(id); },
    note: (t, id) => {
      readInputs(id);
      session.notesOpen[id] = !session.notesOpen[id];
      refreshStation(id);
      if (session.notesOpen[id]) { const el = document.querySelector('#st-' + id + ' .note-input'); if (el) el.focus(); }
    },
    log: (t, id) => logExercise(id),
    undo: (t, id) => {
      const on = L.entryOn(state, id, session.date);
      if (!on) return;
      L.deleteEntry(state, on.id);
      commit();
      session.drafts[id] = { weight: on.weight, sets: on.sets, reps: on.reps, hit: on.hit, note: on.note };
      refreshStation(id);
      toast('Removed from ' + L.fmtShort(session.date));
    },
    'edit-logged': (t, id) => {
      const on = L.entryOn(state, id, session.date);
      if (!on) return;
      session.drafts[id] = { weight: on.weight, sets: on.sets, reps: on.reps, hit: on.hit, note: on.note };
      session.editing[id] = true;
      refreshStation(id);
    },
    'cancel-edit': (t, id) => { session.editing[id] = false; delete session.drafts[id]; refreshStation(id); },
    finish: () => {
      const day = state.days.find((d) => d.id === session.dayId);
      const n = day ? day.exIds.filter((id) => L.entryOn(state, id, session.date)).length : 0;
      go('#/');
      if (n) toast(day.name + ' saved: ' + plural(n, 'exercise') + ' logged');
    },
    'add-ex': (t) => exerciseSheet(null, t.dataset.day),
    'edit-ex': (t, id) => exerciseSheet(id),
    'add-day': () => daySheet(null),
    'rename-day': (t) => daySheet(t.dataset.id),
    'delete-day': (t) => {
      const day = state.days.find((d) => d.id === t.dataset.id);
      if (!day) return;
      const n = state.entries.filter((e) => day.exIds.includes(e.exId)).length;
      if (!confirm('Delete ' + day.name + ', its ' + plural(day.exIds.length, 'exercise') + (n ? ' and ' + plural(n, 'logged session') : '') + '? This can’t be undone.')) return;
      L.deleteDay(state, day.id);
      commit();
      session = null;
      go('#/plan');
      toast(day.name + ' deleted');
    },
    'day-up': (t) => { L.moveDay(state, t.dataset.id, -1); commit(); render(); },
    'day-down': (t) => { L.moveDay(state, t.dataset.id, 1); commit(); render(); },
    'ex-up': (t) => { L.moveExercise(state, t.dataset.id, -1); commit(); render(); },
    'ex-down': (t) => { L.moveExercise(state, t.dataset.id, 1); commit(); render(); },
    'edit-entry': (t) => entrySheet(t.dataset.ex, t.dataset.entry),
    'add-entry': (t, id) => entrySheet(id, null),
    back: (t) => { if (history.length > 1) history.back(); else go(t.dataset.fallback || '#/'); },
    rest: (t) => Rest.start(Number(t.dataset.sec)),
    'rest-add': () => Rest.add(15),
    'rest-stop': () => Rest.stop(),
    'export-json': () => exportData('json'),
    'export-csv': () => exportData('csv'),
    unit: (t) => { state.unit = t.dataset.unit; commit(); render(); },
    erase: () => {
      if (!confirm('Erase every workout, exercise and setting on this phone?')) return;
      if (!confirm('Last check: this can’t be undone unless you have a backup. Erase everything?')) return;
      state = L.emptyState();
      commit();
      session = null;
      go('#/');
      toast('All data erased');
    },
    'apply-update': () => applyUpdate(),
    'hide-install': () => { uiPref('installHidden', true); render(); },
    'sheet-close': () => closeSheet()
  };
  function step(exId, field, dir) {
    readInputs(exId);
    const d = draftFor(exId);
    if (field === 'weight') {
      const inc = state.exercises[exId].inc || 5;
      d.weight = Math.max(0, L.round2(d.weight + dir * inc));
    } else {
      d[field] = Math.min(99, Math.max(1, d[field] + dir));
    }
    refreshStation(exId);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], [data-go]');
    if (!t || t.disabled) return;
    if (t.dataset.go) { e.preventDefault(); go(t.dataset.go); return; }
    const fn = actions[t.dataset.act];
    if (fn) { e.preventDefault(); fn(t, t.dataset.ex); }
  });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.field || !el.dataset.ex || !session) return;
    applyField(draftFor(el.dataset.ex), el.dataset.field, el.value);
    if (el.dataset.field !== 'note') refreshBits(el.dataset.ex);
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'log-date') {
      if (L.isValidISO(el.value) && session) {
        session.date = el.value;
        session.drafts = {}; session.editing = {}; session.notesOpen = {};
        render();
      }
      return;
    }
    if (el.id === 'timer-toggle') { state.showTimer = el.checked; commit(); renderDock(); return; }
    if (el.id === 'import-file') { const f = el.files && el.files[0]; el.value = ''; if (f) importFile(f); return; }
    if (el.dataset && el.dataset.field && el.dataset.ex && session) {
      const d = draftFor(el.dataset.ex);
      applyField(d, el.dataset.field, el.value);
      if (el.dataset.field !== 'note') el.value = el.dataset.field === 'weight' ? fmtW(d.weight) : d[el.dataset.field];
      refreshBits(el.dataset.ex);
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.dataset && (el.dataset.field === 'weight' || el.dataset.field === 'sets' || el.dataset.field === 'reps')) {
      setTimeout(() => { try { el.setSelectionRange(0, el.value.length); } catch (x) { /* ignore */ } }, 0);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetRoot.firstChild) closeSheet();
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.field) { e.preventDefault(); e.target.blur(); }
  });

  // ---------- service worker ----------
  function applyUpdate() {
    if (!swWaiting) return;
    wantReload = true;
    swWaiting.postMessage('skipWaiting');
  }
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) location.reload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const waiting = (w) => {
        swWaiting = w;
        toast('A new version is ready', 'Update', applyUpdate, 0);
        if (route.name === 'data') render();
      };
      if (reg.waiting && navigator.serviceWorker.controller) waiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) waiting(nw); });
      });
      document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) reg.update().catch(() => {}); });
    }).catch((e) => console.warn('Offline support could not start', e));
  }

  async function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        persisted = await navigator.storage.persisted();
        if (!persisted) persisted = await navigator.storage.persist();
      }
    } catch (e) { persisted = null; }
  }

  // ---------- start ----------
  async function init() {
    let loaded = null;
    try { loaded = await Store.load(); } catch (e) { loaded = null; }
    if (loaded) state = loaded;
    else { state = L.seedData(); commit(); }
    render();
    registerSW();
    requestPersist();
  }
  // Exposed for automated tests only.
  window.__gymlog = { get state() { return state; }, Store, Rest };
  init();
})();
