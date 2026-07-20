# Fitness Operations Engine

An operational backend for independent personal trainers and online fitness
coaches. It turns raw, messy programming — the kind coaches type into notes
apps and spreadsheets — into a clean, automated client experience.

No build step, no server, no dependencies. Open `index.html` in a browser and
everything runs locally; data is stored in the browser's localStorage and can
be exported/imported as JSON for backup.

## What it does

1. **Parse raw programming.** Paste a program exactly as a coach would write it
   (`Bench Press 4x8 @ RPE 7 rest 2min`, day headers, supersets like `A1/A2`,
   `%1RM`, tempo, rep ranges) and the engine converts it into structured data.
2. **Manage a client roster.** Track each client's goal, status, check-in day,
   and assigned programs in one dashboard with adherence stats.
3. **Deliver a clean client experience.** One click generates a polished,
   printable client-facing program sheet, a weekly check-in form, and a
   ready-to-send check-in message — no more screenshots of spreadsheets.
4. **Log sessions and automate progression.** Record what a client actually
   lifted; the progression engine compares it against targets and suggests the
   next load/rep adjustments (double-progression style).
5. **Run the week.** The dashboard shows which check-ins are due today, who is
   falling behind on adherence, and which programs are ending soon.

## Quick start

1. Open `index.html`.
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
```

- `Program:` / `Weeks:` / `Client:` header lines set metadata.
- A line like `Day 1 - Push`, `Monday`, or `Upper A:` starts a new day.
- Exercise lines: `Name SETSxREPS` plus any of `@ RPE n`, `@ n%`,
  `rest 90s|2min`, `tempo 3010`, rep ranges (`8-10`), `AMRAP`, or per-side
  reps (`10/side`).
- `A1.`/`A2.` (or `B1`, `ss:`) prefixes group exercises into supersets.
- Lines starting with `-` or `note:` attach a note to the previous exercise
  (or to the day if there's no exercise yet).

## Files

| Path | Purpose |
|------|---------|
| `index.html` | App shell and views |
| `css/styles.css` | All styling, including print styles for deliverables |
| `js/parser.js` | Raw text → structured program parser |
| `js/store.js` | localStorage persistence + JSON import/export |
| `js/progression.js` | Session analysis and progression suggestions |
| `js/deliver.js` | Client-facing deliverables (program sheet, check-in form, messages) |
| `js/app.js` | UI wiring, views, and state |
| `samples/sample-program.txt` | Example raw program for the importer |
| `tests/parser-tests.html` | Browser-run parser test suite |
