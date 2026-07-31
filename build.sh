#!/bin/sh
# Assembles the single-file game from the authoring chunks in src/.
# three.js r128 (MIT) is inlined from vendor/ so the output has zero external
# requests: open nitro-circuit.html in a browser and it runs. No build step
# is needed to *play* it — this script only exists so the source can be
# authored in readable pieces.
set -e
cd "$(dirname "$0")"
OUT=nitro-circuit.html
cat src/00_head.html \
    src/10_util.js \
    src/20_audio.js \
    src/30_input.js \
    src/40_spline.js \
    src/45_trackdata.js \
    src/48_trackbuild.js \
    src/49_track.js \
    src/50_kart.js \
    src/60_ai.js \
    src/70_items.js \
    src/80_fx.js \
    src/90_hud.js \
    src/92_race.js \
    src/95_app.js \
    src/99_boot.js \
    src/zz_tail.html > "$OUT.tmp"
python3 - "$OUT.tmp" "$OUT" <<'PY'
import sys
tmp, out = sys.argv[1], sys.argv[2]
html = open(tmp, encoding='utf-8').read()
three = open('vendor/three.min.js', encoding='utf-8').read()
assert '/*__THREE__*/' in html, 'missing three.js placeholder'
open(out, 'w', encoding='utf-8').write(html.replace('/*__THREE__*/', three, 1))
PY
rm -f "$OUT.tmp"
echo "built $OUT ($(wc -c < "$OUT") bytes)"
