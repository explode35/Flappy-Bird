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

# Second target: the same game as a document *fragment*, for hosts that supply
# their own <html>/<head>/<body> skeleton. The viewport meta has to be injected
# at runtime there, and without it phones render at desktop width.
python3 - "$OUT" nitro-circuit.fragment.html <<'PY2'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
h = open(src, encoding='utf-8').read()
style = re.search(r'<style>(.*?)</style>', h, re.S).group(1)
body = h.split('<body>', 1)[1].rsplit('</body>', 1)[0]
out = (
  '<script>\n'
  '(function(){\n'
  '  var m = document.querySelector(\'meta[name="viewport"]\');\n'
  '  if (!m) { m = document.createElement("meta"); m.name = "viewport"; document.head.appendChild(m); }\n'
  '  m.content = "width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover";\n'
  '})();\n'
  '</script>\n'
  '<style>' + style + '</style>\n' + body
)
open(dst, 'w', encoding='utf-8').write(out)
print('built %s (%d bytes)' % (dst, len(out)))
PY2
