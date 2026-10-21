# Gym Log

A workout tracker for your iPhone that works with no signal. Everything is stored on the phone. No account, no server, no build step.

Your current Push and Pull history (Oct 13 to Oct 20, 2026) is already loaded the first time you open it.

## What's in the folder

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js`, `logic.js` | The app |
| `sw.js` | Service worker: saves the app on the phone so it opens offline |
| `manifest.webmanifest`, `icon-*.png` | Name and icon for the Home Screen |
| `README.md` | This file |
| `dev/` | Automated tests. Not needed to host or use the app |

All the app files sit at the top level (no subfolders), so you can upload them from the iPhone Files app in one go.

---

## 1. Put it online (free)

You only need a web address once: the first visit saves the app onto the phone. Pick one option.

### Option A: GitHub Pages (recommended, stays up for free)

1. Sign up at **github.com** (free).
2. Tap **+** then **New repository**. Name it `gym-log`. Set it to **Public** (free accounts need a public repository for Pages). Tap **Create repository**.
3. On the empty repository page, tap **uploading an existing file**.
4. Upload every file from the `gym-log` folder: the files themselves, not the folder. You can leave out `dev/`.
   - On a computer: drag the files onto the page.
   - On the iPhone: unzip `gym-log.zip` in the Files app (tap it once), then on github.com tap **choose your files**, open the `gym-log` folder and select all the files.
5. Tap **Commit changes**.
6. Go to **Settings**, then **Pages** in the sidebar. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick **main** and **/ (root)**, then **Save**.
7. Wait a minute or two and refresh. The address appears at the top of the Pages screen:
   `https://YOUR-USERNAME.github.io/gym-log/`

### Option B: Netlify

1. Sign up at **netlify.com** first (free). Sites dropped without an account are password-protected and get deleted, so claim it from the start.
2. Open **app.netlify.com/drop** on a computer and drag the whole `gym-log` folder onto the page.
3. You get an address like `https://something-random.netlify.app`. You can rename it under **Site configuration**.

---

## 2. Install it on your iPhone

1. Open your address in **Safari** while you have signal. Let it load fully. This visit saves the whole app on the phone.
2. Tap the **•••** button next to the address bar, then **Share**, then scroll down and tap **Add to Home Screen**.
   (Older iOS: tap the Share button at the bottom of the screen, then **Add to Home Screen**.)
3. Leave **Open as Web App** turned on, then tap **Add**.
4. Open **Gym Log** from the Home Screen once while online.
5. Test it: turn on **Airplane Mode**, close the app, open it again. It should open normally with your data.

### Read this once: where your data lives

- The Home Screen app keeps **its own storage**, separate from Safari. Anything you log in a Safari tab will not show up in the installed app. Always log from the icon.
- **Deleting the Home Screen icon deletes its data.** Back up first.
- Apps added to the Home Screen are not subject to Safari's automatic 7-day cleanup of website data, but a phone reset or a deleted icon still wipes it. Back up every week or two (the app reminds you after 14 days).

**Back up:** Data tab, **Save backup (JSON)**, then **Save to Files** (iCloud Drive is a good spot).
**Restore or move to a new phone:** install the app, then Data tab, **Import a file**, pick the backup, and choose **Replace my log with this backup**.

---

## 3. Using it

**Log a workout (well under a minute):** tap **Push**. Each exercise shows what you did last time with the numbers already filled in.

- Did the same thing? Tap **Same as last time**.
- Changed something? Use **−** and **+** (weight moves by the exercise's step, 5 lb by default), or tap the number and type it. The button changes to **Log 25 lb, 3×8**.
- Didn't finish every rep? Tap **Missed reps** before logging.
- Logged the wrong thing? **Edit** or **Undo** on the card.

The date defaults to today. Tap it to log a past workout.

**Progression nudge:** if you hit every set and rep last time, the card suggests one step heavier (yellow, with a **Use 25** button). If you missed reps, it tells you to stay at the same weight. At 0 lb (bodyweight) it suggests one more rep.

**Assisted machines:** in Plan, edit the exercise and turn on **Assisted machine**. The nudge then suggests *less* assistance, and the chart reads "down is better". *Chin up machine is preloaded as assisted. If yours isn't, switch it off in Plan.*

**Weight note:** for entries that aren't a plain number, give the exercise a note like `+ bar`, `per dumbbell` or `assisted`. It shows next to the weight everywhere. Each session can also have its own note (**Add note** on the card).

**Rest timer:** the bar at the bottom of a workout. Tap 1:00, 1:30, 2:00 or 3:00 to start, **+15s** to extend. The screen stays awake while it runs, and it beeps and flashes at zero. The beep follows your ringer switch, and iOS won't play it while the phone is locked; the countdown stays correct either way. Turn the timer off in Data.

**History:** each exercise has a weight-over-time chart (hollow dots are sessions with missed reps), your best, and every session. Tap a session to fix it, or **Add a past session**.

**Plan:** add, rename, reorder and delete workout days (like Legs) and their exercises. Exercises can be moved to another day from their edit screen.

---

## 4. Export and import

- **JSON** is the full backup: days, exercises, notes, settings and history.
- **CSV** opens in Numbers or Excel. Columns:
  `date, day, exercise, weight, unit, sets, reps, all_reps_hit, exercise_note, entry_note`
  Notes that start with `+` (like `+ bar`) are written as `'+ bar` so spreadsheets don't treat them as formulas. Import strips that back off.
- **Importing** either file lets you **Add to my log** (merges, skipping sessions you already have, matching days and exercises by name) or, for JSON, **Replace my log with this backup**.
- You can bring in more history by making a spreadsheet with at least `date, exercise, weight, sets, reps` columns (`day` is optional; dates like `2026-10-19` or `10/19/2026`), saving as CSV, and importing it.

---

## 5. Changing the app later

1. Edit the files.
2. In `sw.js`, bump `VERSION` (for example `gymlog-v1.0.0` to `gymlog-v1.0.1`). The phone only picks up changes when this changes.
3. Upload the changed files again (GitHub: **Add file**, **Upload files**; Netlify: drag the folder onto **Deploys**).
4. Open the app with signal. A **New version is ready** message appears. Tap **Update**. Your data is untouched. Updates never install mid-workout on their own.

---

## 6. Tests

```
cd dev
npm install
npx playwright install chromium
npm test
```

`logic.test.js` checks the data rules: the preloaded history, last-time lookup, the nudge, CSV round trips, and merge without duplicates. `e2e.test.js` runs the real app in headless Chromium on an iPhone-sized touch screen: it loads once, **shuts the web server down and goes offline**, then logs, edits, charts, plans, exports and imports with no network, checks data survives reloads, and installs an update.
