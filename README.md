# PERFECT 82

A mobile-first basketball draft game. Five picks, five positions, three prospects per round —
build a starting five and find out how many games it wins.

Inspired by the playable "can you build an 82-0 team?" ad format: pick one of three cards,
watch the Team Power meter move, get roasted in real time for a bad pick, then get a
projected season record at the end.

## Play

Open `index.html` in any browser — no build step, no dependencies, no network calls.
It is a single self-contained file.

On a phone: serve the repo (e.g. GitHub Pages) and open it, then "Add to Home Screen"
for a full-screen, chrome-less experience.

```bash
# quick local server
python3 -m http.server 8000
# then visit http://localhost:8000 on your phone (same Wi-Fi)
```

## How it plays

1. **Five rounds**, one per position: PG → SG → SF → PF → C.
2. Each round deals **three prospects** — one all-time great, one solid starter,
   usually one famous bust. Tap one.
3. The pick flies into your lineup strip, **Team Power** climbs, and the arena reacts:
   *SOLID PICK*, *TWO-WAY BEAST*, or *WHAT IS HE DOING?! WHY NOT JORDAN 🤦*.
4. After the final pick the season is simulated and you get a **projected record**,
   a grade, and the chemistry that made or broke it.

### Scoring

- Each starter contributes up to 20 points of Team Power based on their OVR.
- **Chemistry** then adjusts the total: spacing, ball movement, and rim protection help;
  no creator, no rim protection, too many ball-stoppers, or a weak link hurt.
- Wins are non-linear — `82 × (power/100)^1.7` — so one 56 OVR starter really does
  cost you twenty games.
- Going **82-0** requires the best player at every position *and* perfect chemistry.
  It is meant to be rare.

Your best season is saved to `localStorage`.

## Tech

Single HTML file, ~700 lines. No frameworks, no images, no fonts, no requests.

- Arena, court, crowd lights, and cards are all CSS gradients and shadows.
- Pick animation is a FLIP transition from the card to its roster slot.
- Sound is synthesised on the fly with the Web Audio API (toggle in the top right);
  haptics via `navigator.vibrate` where supported.
- Sized with `dvh` + `clamp()` and safe-area insets; verified with no scroll or overflow
  from iPhone SE (375×667) up.
- Share uses the Web Share API with a clipboard fallback.

## Players

The pool is 43 real NBA players — 8–9 per position, listed by career regular-season
averages (PPG / RPG / APG). Every position pairs all-time greats with famous busts,
which is where the pick tension comes from: Magic, Curry and Stockton share a pool
with Markelle Fultz; Kareem, Wilt and Hakeem share one with Greg Oden and Kwame Brown.

Ratings are subjective and tuned for play balance, not a ranking. Names and stats are
used as factual identifiers, with no team logos, uniforms, or player likenesses — fine
for a personal project, but commercial release would need NBA/NBPA licensing.
