// End-to-end test in headless Chromium on an iPhone-sized touch screen.
// Proves: first load caches the app, it then works with the server completely gone,
// logging is fast, data survives reloads, export/import work, and updates install cleanly.
// Run: npm install && npm test   (needs Playwright's Chromium: npx playwright install chromium)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'gymlog-shots');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

function copyApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymlog-site-'));
  for (const f of fs.readdirSync(SRC)) {
    if (fs.statSync(path.join(SRC, f)).isFile()) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  return dir;
}
function serve(root, port) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    requests.push(p);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port || 0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}
const stop = (srv) => new Promise((r) => { srv.server.closeAllConnections(); srv.server.close(() => r()); });

test('Gym Log PWA end to end', { timeout: 120000 }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const site = copyApp();
  let srv = await serve(site);
  const port = srv.port;
  const url = 'http://127.0.0.1:' + port + '/';

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    timezoneId: 'America/New_York', acceptDownloads: true, serviceWorkers: 'allow',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Mobile Safari/537.36'
  });
  // Pin "today" to Tue Oct 20, 2026 (evening, New York) so date text is the same whenever this runs. Time still flows.
  await context.clock.install({ time: new Date('2026-10-20T19:00:00-04:00') });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
  const S = () => page.evaluate(() => window.__gymlog.state);

  await t.test('first load: seeded data, home screen, offline cache filled', async () => {
    await page.goto(url);
    await page.waitForSelector('.day-row');
    const rows = await page.$$eval('.day-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    assert.match(rows[0], /^Push 4 exercises, last done yesterday Up next/);
    assert.match(rows[1], /^Pull 4 exercises, last done today Done today/);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const c = await caches.open(keys.find((k) => k.startsWith('gymlog-')));
      return (await c.keys()).map((r) => new URL(r.url).pathname).sort();
    });
    const swSrc = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
    const listed = JSON.parse(swSrc.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
    assert.equal(cached.length, listed.length, 'every asset in the precache list is cached');
    for (const a of listed) assert.ok(a === './' || fs.existsSync(path.join(SRC, a)), a + ' exists on disk');
    // Everything index.html references must be precached.
    const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
    for (const ref of html.match(/(?:href|src)="([^"#:]+)"/g).map((m) => m.split('"')[1])) {
      assert.ok(listed.includes('./' + ref), ref + ' referenced by index.html is precached');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.webmanifest'), 'utf8'));
    for (const i of manifest.icons) assert.ok(listed.includes('./' + i.src), i.src + ' precached');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    await shot('01-home');
  });

  await t.test('log a full Push workout in a handful of taps', async () => {
    await page.tap('.day-row >> text=Push');
    await page.waitForSelector('.station');
    const lasts = await page.$$eval('.station .last', (els) => els.map((e) => e.textContent));
    assert.deepEqual(lasts, [
      'Last time 20 lb, 3×8 on Mon, Oct 19',
      'Last time 25 lb + bar, 3×8 on Mon, Oct 19',
      'Last time 20 lb, 3×8 on Mon, Oct 19',
      'Last time 70 lb, 3×8 on Mon, Oct 19'
    ]);
    const nudges = await page.$$eval('.station .nudge span', (els) => els.map((e) => e.textContent));
    assert.equal(nudges[0], 'You hit every rep last time. Try 25 lb.');
    assert.equal(nudges[1], 'You hit every rep last time. Try 30 lb.');
    assert.equal(await page.textContent('.station .plabel'), 'Same as last time');
    await shot('02-log-before');

    const st = (i) => '.station >> nth=' + i;
    const t0 = Date.now();
    let taps = 0;
    const tap = async (sel) => { await page.tap(sel); taps++; };
    // 1. Shoulder press: take the nudge (25 lb) and log.
    await tap(st(0) + ' >> [data-act="use-sug"]');
    assert.equal(await page.inputValue(st(0) + ' >> [data-field="weight"]'), '25');
    assert.match(await page.textContent(st(0) + ' >> .nudge'), /Up 5 lb from last time/);
    await tap(st(0) + ' >> [data-act="log"]');
    // 2. Incline: + once (30) and log.
    await tap('#st-' + (await exId('Incline bench press')) + ' [data-act="w+"]');
    await tap('#st-' + (await exId('Incline bench press')) + ' [data-act="log"]');
    // 3. Bicep: one tap repeat.
    await tap('#st-' + (await exId('Dumbbell bicep')) + ' [data-act="log"]');
    // 4. Bench machine: type 75 on the keypad, mark missed reps, log.
    const bench = '#st-' + (await exId('Bench press machine'));
    await page.fill(bench + ' [data-field="weight"]', '75');
    assert.equal(await page.textContent(bench + ' .plabel'), 'Log 75 lb, 3×8');
    await tap(bench + ' [data-act="hit"]');
    await tap(bench + ' [data-act="log"]');
    const ms = Date.now() - t0;
    assert.equal(await page.textContent('#progress'), '4 of 4 logged');
    assert.ok(taps <= 8, 'taps: ' + taps);
    console.log('  full Push workout: ' + taps + ' taps + one typed number, ' + ms + ' ms of automation');
    const s = await S();
    const tday = await page.evaluate(() => window.GymLogic.todayISO());
    const todays = s.entries.filter((e) => e.date === tday && s.days[0].exIds.includes(e.exId))
      .map((e) => [s.exercises[e.exId].name, e.weight, e.sets, e.reps, e.hit]);
    assert.deepEqual(todays.sort(), [
      ['Bench press machine', 75, 3, 8, false],
      ['Dumbbell bicep', 20, 3, 8, true],
      ['Dumbbell shoulder press (seated)', 25, 3, 8, true],
      ['Incline bench press', 30, 3, 8, true]
    ].sort());
    await page.waitForSelector('.toast >> text=Push done');
    await shot('03-log-done');
  });

  async function exId(name) {
    return page.evaluate((n) => { const s = window.__gymlog.state; return Object.values(s.exercises).find((e) => e.name === n).id; }, name);
  }

  await t.test('edit and undo a logged exercise', async () => {
    const bicep = '#st-' + (await exId('Dumbbell bicep'));
    await page.tap(bicep + ' [data-act="edit-logged"]');
    assert.equal(await page.textContent(bicep + ' .plabel'), 'Save changes');
    await page.tap(bicep + ' [data-act="reps+"]');
    await page.tap(bicep + ' [data-act="log"]');
    assert.match(await page.textContent(bicep + ' .result'), /20 lb 3×9/);
    await page.tap(bicep + ' [data-act="undo"]');
    assert.equal(await page.textContent('#progress'), '3 of 4 logged');
    await page.tap(bicep + ' [data-act="log"]');
    assert.equal(await page.textContent('#progress'), '4 of 4 logged');
  });

  await t.test('back-dating a session shows the session before it', async () => {
    await page.fill('#log-date', '2026-10-19');
    await page.dispatchEvent('#log-date', 'change');
    await page.waitForSelector('.station.logged');
    assert.equal(await page.textContent('#progress'), '4 of 4 logged'); // Oct 19 Push already logged
    await page.tap('.station >> nth=0 >> [data-act="edit-logged"]');
    assert.match(await page.textContent('.station >> nth=0 >> .last'), /15 lb, 3×8 on Tue, Oct 13/);
    await page.tap('.station >> nth=0 >> [data-act="cancel-edit"]');
  });

  await t.test('rest timer counts down, extends, and finishes', async () => {
    await page.tap('[data-act="rest"][data-sec="90"]');
    assert.match(await page.textContent('#rest-clock'), /^1:(30|29)$/);
    await page.tap('[data-act="rest-add"]');
    assert.match(await page.textContent('#rest-clock'), /^1:(45|44)$/);
    await shot('04-rest-timer');
    await page.tap('[data-act="rest-stop"]');
    assert.equal(await page.$('#rest-clock'), null);
    await page.evaluate(() => window.__gymlog.Rest.start(1));
    await page.waitForSelector('.rest.done >> text=Next set', { timeout: 4000 });
    await page.tap('[data-act="rest-stop"]');
  });

  await t.test('data survives a reload (IndexedDB + localStorage mirror)', async () => {
    await page.reload();
    await page.waitForSelector('.station');
    const s = await S();
    assert.equal(s.entries.length, 18);
    const both = await page.evaluate(async () => {
      const ls = JSON.parse(localStorage.getItem('gymlog-state')).entries.length;
      const idb = await new Promise((res) => {
        const r = indexedDB.open('gymlog', 1);
        r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('state'); g.onsuccess = () => res(JSON.parse(g.result).entries.length); };
      });
      return [ls, idb];
    });
    assert.deepEqual(both, [18, 18]);
  });

  await t.test('works with no network at all', async () => {
    await stop(srv);                       // the web server is gone
    await context.setOffline(true);        // and the device is offline
    await page.goto(url);
    await page.waitForSelector('.day-row');
    assert.match(await page.textContent('.day-row >> nth=0'), /Done today/);
    // History and chart, offline.
    await page.tap('.tab >> text=History');
    await page.tap('.row >> text=Dumbbell shoulder press (seated)');
    await page.waitForSelector('.chart svg');
    assert.equal(await page.$$eval('.chart circle', (c) => c.length), 3);
    assert.equal(await page.textContent('.stat >> nth=0 >> b'), '25');
    await shot('05-history-offline');
    // Log something offline, reload offline, still there.
    await page.goto(url + '#/log/' + (await S()).days[1].id);
    await page.waitForSelector('.station');
    const lat = '#st-' + (await exId('Lateral pull machine'));
    await page.tap(lat + ' [data-act="edit-logged"]');
    await page.tap(lat + ' [data-act="w+"]');
    await page.tap(lat + ' [data-act="log"]');
    await page.reload();
    await page.waitForSelector('.station');
    assert.match(await page.textContent(lat + ' .result'), /^95 lb/);
    // A brand-new tab also opens offline (what tapping the home-screen icon does).
    const p2 = await context.newPage();
    await p2.goto(url);
    await p2.waitForSelector('.day-row');
    await p2.close();
    // Deep link straight into a screen while offline.
    const p3 = await context.newPage();
    await p3.goto(url + '#/plan');
    await p3.waitForSelector('.rows .title');
    await p3.close();
  });

  await t.test('plan: add, rename, reorder and delete days and exercises (offline)', async () => {
    await page.goto(url + '#/plan');
    await page.tap('[data-act="add-day"]');
    await page.fill('.sheet input[name="name"]', 'Legs');
    await page.tap('.sheet button[type="submit"]');
    await page.waitForSelector('.top h1 >> text=Legs');
    await page.tap('[data-act="add-ex"]');
    await page.fill('.sheet input[name="name"]', 'Leg press');
    await page.fill('.sheet input[name="note"]', 'sled');
    await page.fill('.sheet input[name="inc"]', '10');
    await page.tap('.sheet button[type="submit"]');
    await page.tap('[data-act="add-ex"]');
    await page.fill('.sheet input[name="name"]', 'Calf raise');
    await page.tap('.sheet button[type="submit"]');
    await page.tap('[data-act="ex-up"] >> nth=1');
    const names = await page.$$eval('.rows .title', (els) => els.map((e) => e.textContent));
    assert.deepEqual(names, ['Calf raise', 'Leg press']);
    await page.tap('[data-act="rename-day"]');
    await page.fill('.sheet input[name="name"]', 'Legs & core');
    await page.tap('.sheet button[type="submit"]');
    await page.waitForSelector('.top h1 >> text=Legs & core');
    await shot('06-plan-day');
    // Move "Legs & core" above Pull.
    await page.goto(url + '#/plan');
    await page.tap('[data-act="day-up"] >> nth=2');
    assert.deepEqual(await page.$$eval('.rows .tap .title', (e) => e.map((x) => x.textContent)), ['Push', 'Legs & core', 'Pull']);
    // New exercise logs from scratch, with sensible defaults.
    await page.goto(url + '#/log/' + (await S()).days[1].id);
    await page.waitForSelector('.station');
    assert.match(await page.textContent('.station >> nth=1 >> .last'), /First time/);
    await page.fill('.station >> nth=1 >> [data-field="weight"]', '180');
    await page.dispatchEvent('.station >> nth=1 >> [data-field="weight"]', 'change');
    assert.equal(await page.textContent('.station >> nth=1 >> .plabel'), 'Log 180 lb, 3×8');
    await page.tap('.station >> nth=1 >> [data-act="log"]');
    // Edit sheet from the log screen moves an exercise to another day.
    await page.goto(url + '#/plan/' + (await S()).days[1].id);
    await page.tap('.rows .tap >> text=Calf raise');
    await page.selectOption('.sheet select[name="day"]', { label: 'Push' });
    await page.tap('.sheet button[type="submit"]');
    assert.deepEqual(await page.$$eval('.rows .title', (els) => els.map((e) => e.textContent)), ['Leg press']);
    // Delete the day (confirm accepted automatically).
    await page.tap('[data-act="delete-day"]');
    await page.waitForSelector('.page-head h1 >> text=Plan');
    assert.deepEqual(await page.$$eval('.rows .tap .title', (e) => e.map((x) => x.textContent)), ['Push', 'Pull']);
    const s = await S();
    assert.ok(!Object.values(s.exercises).some((e) => e.name === 'Leg press'));
    assert.ok(Object.values(s.exercises).some((e) => e.name === 'Calf raise'));
  });

  await t.test('history: add and edit a past session', async () => {
    const id = await exId('Seated row machine');
    await page.goto(url + '#/ex/' + id);
    await page.tap('[data-act="add-entry"]');
    await page.fill('.sheet input[name="date"]', '2026-10-07');
    await page.fill('.sheet input[name="weight"]', '35');
    await page.tap('.sheet button[type="submit"]');
    assert.deepEqual(await page.$$eval('.entry-row .title', (e) => e.map((x) => x.textContent)), ['40 lb', '35 lb']);
    await page.tap('.entry-row >> nth=1');
    await page.tap('.sheet .switch input[name="hit"]');
    await page.fill('.sheet input[name="note"]', 'first try');
    await page.tap('.sheet button[type="submit"]');
    assert.match(await page.textContent('.entry-row >> nth=1'), /missed reps\. first try/);
    await page.tap('.entry-row >> nth=1');
    await page.tap('.sheet [data-role="delete"]');
    assert.equal(await page.$$eval('.entry-row', (e) => e.length), 1);
  });

  let backupPath;
  await t.test('export JSON and CSV (offline)', async () => {
    await page.goto(url + '#/data');
    await page.waitForSelector('[data-act="export-json"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('[data-act="export-json"]')]);
    assert.match(dl.suggestedFilename(), /^gym-log-\d{4}-\d{2}-\d{2}\.json$/);
    backupPath = path.join(SHOTS, dl.suggestedFilename());
    await dl.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(backup.app, 'gymlog');
    assert.equal(backup.entries.length, (await S()).entries.length);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.tap('[data-act="export-csv"]')]);
    const csvPath = path.join(SHOTS, dl2.suggestedFilename());
    await dl2.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.ok(csv.startsWith('date,day,exercise,weight,unit,sets,reps,all_reps_hit,exercise_note,entry_note\r\n'));
    assert.ok(csv.includes('2026-10-13,Push,Incline bench press,20,lb,3,8,yes,\'+ bar,'));
    assert.match(await page.textContent('.kv >> nth=0'), /Last backup.*Tue, Oct 20/);
    await shot('07-data');
  });

  await t.test('import: same backup adds nothing; CSV merges; JSON replaces', async () => {
    await page.setInputFiles('#import-file', backupPath);
    await page.waitForSelector('.sheet >> text=Everything in it is already in your log.');
    assert.equal(await page.isDisabled('.sheet button[type="submit"]'), true);
    await page.tap('.sheet [data-act="sheet-close"]');

    const csvFile = path.join(SHOTS, 'legs.csv');
    fs.writeFileSync(csvFile, 'date,day,exercise,weight,sets,reps\n10/22/2026,Legs,Leg press,180,3,10\n2026-10-22,Legs,Calf raise,90,4,12\n2026-10-20,Pull,Tricep pulley,35,3,8\n');
    await page.setInputFiles('#import-file', csvFile);
    await page.waitForSelector('.sheet >> text=Adding it brings in 2 new sessions and skips 1 you already have.');
    await shot('08-import');
    await page.tap('.sheet button[type="submit"]');
    let s = await S();
    assert.ok(s.days.some((d) => d.name === 'Legs'));
    assert.equal(Object.values(s.exercises).filter((e) => e.name === 'Calf raise').length, 1, 'matched existing Calf raise by name');

    await page.setInputFiles('#import-file', backupPath);
    await page.tap('.sheet [data-role="replace"]');
    s = await S();
    assert.ok(!s.days.some((d) => d.name === 'Legs'));
    const bad = path.join(SHOTS, 'bad.json');
    fs.writeFileSync(bad, '{"not":"a backup"}');
    await page.setInputFiles('#import-file', bad);
    await page.waitForSelector('.toast >> text=This file is not a Gym Log backup.');
  });

  await t.test('update flow: new version installs only when you tap Update, data intact', async () => {
    await context.setOffline(false);
    fs.writeFileSync(path.join(site, 'sw.js'), fs.readFileSync(path.join(site, 'sw.js'), 'utf8').replace("gymlog-v1.0.0", 'gymlog-v1.0.1'));
    srv = await serve(site, port);
    const before = (await S()).entries.length;
    await page.goto(url);
    await page.waitForSelector('.day-row');
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector('.toast >> text=A new version is ready', { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => caches.keys()).then((k) => k.sort()), ['gymlog-v1.0.0', 'gymlog-v1.0.1']);
    await Promise.all([page.waitForEvent('load'), page.tap('.toast button')]);
    await page.waitForSelector('.day-row');
    await page.waitForFunction(async () => (await caches.keys()).join() === 'gymlog-v1.0.1');
    assert.equal((await S()).entries.length, before);
  });

  await t.test('no errors in the console', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close();
  await stop(srv);
});
