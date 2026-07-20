# Fitness Operations Engine

An operational backend for independent personal trainers and online fitness
coaches. It turns raw, messy programming — the kind coaches type into notes
apps and spreadsheets — into a clean, automated client experience.

No build step, no server, no dependencies. Open `index.html` in a browser and
everything runs locally; data is stored in the browser's localStorage and can
be exported/imported as JSON for backup.

## What it does

1. **Parse raw programming — including workout formats.** Paste a program
   exactly as a coach would write it (`Bench Press 4x8 @ RPE 7 rest 2min`, day
   headers, supersets like `A1/A2`, `%1RM`, tempo, rep ranges) *and* whole
   workout formats — `AMRAP 12 min`, `Tabata 8x20/10`, `EMOM 10`,
   `3 Rounds For Time`, `Circuit` — and the engine structures every block with
   its style made explicit.
2. **Manage a client roster.** Track each client's goal, status, check-in day,
   phone, SMS consent, and assigned programs in one dashboard with adherence
   stats.
3. **Give each client a private portal.** Every client gets a mobile-first
   portal at a private link (`/p/<token>`) where each session's exact style —
   AMRAP, Tabata, straight sets — is clear *before they hit start*, with the
   precise rounds and reps, built-in workout timers, and a one-tap check-in.
   No more squinting at a spreadsheet on a phone.
4. **Deliver polished artifacts.** One click also generates a printable
   program sheet (with format banners), a weekly check-in form, and
   ready-to-send welcome / portal / check-in messages.
5. **Log sessions and automate progression.** Record what a client actually
   lifted; the progression engine compares it against targets and suggests the
   next load/rep adjustments (double-progression style).
6. **Run the week.** The dashboard shows which check-ins are due today, who is
   falling behind on adherence, and which programs are ending soon.
7. **Automate check-ins over SMS.** An optional zero-dependency Node service
   (`sms/`) runs the weekly sequence: check-in request on each client's
   check-in day → one reminder if they go quiet → their reply (SMS or portal)
   auto-parsed into a check-in record → confirmation text back. Respects TCPA
   consent and STOP/START opt-out. Runs in dry-run mode without Twilio
   credentials. See `sms/README.md`.

## Quick start

1. Open `index.html` directly, **or** run `node sms/server.js` and open
   http://localhost:3000 to also get automated SMS check-ins and server-side
   data storage.
2. Go to **Import** and click "Load sample" (or paste your own raw program —
   see `samples/sample-program.txt` for the accepted notation).
3. Click **Parse**, review the structured preview, then **Save program**.
4. Add a client under **Clients** and assign the program.
5. Use **Deliver** on a client to generate their program sheet and check-in
   form, and **Log session** to record training and get progression
   suggestions.

## Raw programming notation

The parser is forgiving, but understands this vocabulary:

```
Program: Hypertrophy Block 1
Weeks: 4

Day 1 - Push
Bench Press 4x8 @ RPE 7 rest 2min
Incline DB Press 3x10-12 rest 90s
A1. Cable Fly 3x15
A2. Lateral Raise 3x15 rest 60s
- keep elbows tucked on pressing

Day 2 - Pull
Deadlift 3x5 @ 80% rest 3min tempo 2010
...

Day 4 - Conditioning
Strength:
Push Press 5x3 @ 80% rest 2min

AMRAP 12 min
10 Kettlebell Swings
15 cal Row
Max Push-ups

Tabata 8 x 20/10
Air Squats

EMOM 10
Odd: 12 Wall Balls
Even: 10 Burpees

Finisher - 3 Rounds For Time
400m Run
21 Deadlifts
```

- `Program:` / `Weeks:` / `Client:` header lines set metadata.
- A line like `Day 1 - Push`, `Monday`, or `Upper A:` starts a new day.
- **Workout-format headers** start a new block and make its style explicit:
  `AMRAP 12 min`, `Tabata 8x20/10`, `EMOM 10`, `3 Rounds For Time`, `Circuit`.
  A section prefix works too (`Finisher - 3 Rounds For Time`, `Metcon: AMRAP 12`).
  Named sections `Strength:` / `Conditioning:` / `Accessory:` start a
  straight-sets block.
- Inside a format block, exercises are written reps-first: `10 Kettlebell
  Swings`, `15 cal Row`, `Max Push-ups`, and EMOM minute tags `Odd:` / `Even:`.
- Standard exercise lines: `Name SETSxREPS` plus any of `@ RPE n`, `@ n%`,
  `rest 90s|2min`, `tempo 3010`, rep ranges (`8-10`), `AMRAP`, or per-side
  reps (`10/side`).
- `A1.`/`A2.` (or `B1`, `ss:`) prefixes group exercises into supersets.
- Lines starting with `-` or `note:` attach a note to the previous exercise
  (or to the block/day if there's no exercise yet).

## The client portal

When the app is served by `node sms/server.js`, every client gets a private,
mobile-first portal at `/p/<token>`:

- Each block leads with a **color-coded format banner** (`AMRAP · 12 MIN`,
  `TABATA · 8 × 20s/10s`, `EMOM · 10 MIN`, `3 ROUNDS FOR TIME`) and a
  plain-English explainer, so the client knows the style before they start.
- Precise rounds and reps for every movement.
- **Built-in timers** for the timed pieces — AMRAP countdown, EMOM
  minute-by-minute, Tabata work/rest with beeps and vibration, For Time
  stopwatch.
- A one-tap **weekly check-in** that posts straight back to the coach's
  dashboard (tagged `Portal`), closing that week's SMS sequence so the client
  isn't nagged.

The portal API is strictly token-scoped: it exposes only the one client's
first name, check-in day, and assigned program — never other clients, phone
numbers, emails, logs, or the coach's full store. Copy or send a client their
link from their page in the **Clients** view.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Coach app shell and views |
| `portal.html` | Client-facing portal shell (served at `/p/<token>`) |
| `css/styles.css` | Coach-app styling, including print styles for deliverables |
| `css/portal.css` | Mobile-first client portal styling |
| `js/parser.js` | Raw text → structured program parser (formats + blocks) |
| `js/store.js` | Persistence, remote sync, migration, portal tokens |
| `js/progression.js` | Session analysis and progression suggestions |
| `js/deliver.js` | Coach deliverables (program sheet, check-in form, messages) |
| `js/portal.js` | Client portal: rendering, format banners, workout timers |
| `js/app.js` | Coach UI wiring, views, and state |
| `samples/sample-program.txt` | Example raw program for the importer |
| `tests/parser-tests.html` | Browser-run parser + progression test suite |
| `sms/engine.js` | SMS + portal logic: scheduling, parsing, consent, scoped views |
| `sms/server.js` | Node service: Twilio, shared state API, portal API, hosting |
| `sms/test.js` | Node-run engine test suite (`node sms/test.js`) |
| `sms/README.md` | SMS setup, config, Twilio wiring, portal notes |
