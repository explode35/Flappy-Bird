# Circuit Sentinels — Core Defense

A tower-defense game in a single HTML file: `index.html`. No build step, no
dependencies, no network calls — open the file in any modern browser (or serve
the folder) and play. Works with mouse or touch.

Same gameplay loop as the grid/merge tower-defense games the format comes from —
intruders walk a fixed path, you deploy units on the tiles beside it, and two
matching units of the same level fuse into a stronger one — but with a
circuit-board theme instead of critters: rogue data-swarms crawling a PCB trace
toward your Core.

## Playing

| Action | How |
| --- | --- |
| Deploy | Pick a card in the bottom bar (or press `1`–`6`), tap a dark tile |
| **Merge** | Drag a sentinel onto another of the **same class and same level** → one level higher, free |
| Move | Drag a sentinel onto an empty tile — no cost |
| Inspect | Tap a placed sentinel for stats, an energy upgrade, targeting mode, or sell (70% refund) |
| Call wave | Start the next wave early for bonus energy |
| Speed / pause | Speed chip or `Space` (1x/2x/3x) · `Esc` pauses |

Energy comes from kills and from clearing waves. Leaked intruders damage the
Core; lose all integrity and the sector is lost. Zero leaks earns ★★★.

## Content

- **15 sectors** across three zones (Circuit Plains, Data Foundry, Null Core),
  each with its own path layout, 8–20 waves and a rising difficulty curve.
  A DAEMON boss closes sectors 5, 10 and 15.
- **6 sentinel classes** — Arc Node (fast single-target), Pulse Mortar (splash),
  Cryo Emitter (slow field), Tesla Coil (chain lightning), Rail Lance
  (long-range, armour-piercing) and Amp Pylon (buffs neighbours). Three are
  unlocked by progress or bought in the lab.
- **5 levels per sentinel**, reached by merging or by spending energy, plus four
  targeting modes each.
- **17 permanent lab upgrades** bought with ◈ cores: damage, fire rate, range,
  crit, starting energy, salvage, wave dividend, core plating, repair drone,
  cryo potency, blast radius, chain targets, merge bonus, sell refund and the
  three class unlocks.
- **9 intruder types** including armoured Bulwarks, dodging Phantoms, Carriers
  that split on death and Menders that heal the pack.

Progress (stars, cores, lab levels) is saved to `localStorage`; the lab screen
has a reset button.

## Repository note

`Code` is the original single-file Flappy Bird game and is untouched.
