# The Corporate Training Architect

Turn a 45-minute expert audio brain dump into a fully structured, 18-week
corporate training program — complete with week-by-week 5E instructional
pacing guides and diagnostic screeners.

**The pitch:** *"Stop wasting time manually training your staff. Give me a
45-minute audio recording, and I will hand you a fully structured, 18-week
onboarding program."*

---

## What this repo contains

| Path | What it is |
|---|---|
| `pipeline/` | The AI pipeline (Python + Anthropic API) that converts a raw transcript into the full deliverable |
| `business/` | The client-facing business kit: pitch scripts, pricing, intake questionnaire, SOW template, delivery checklist |
| `sample/` | A sample expert transcript you can run the pipeline against end-to-end |

## The service workflow

1. **Sell** — use `business/pitch-kit.md` (cold email, LinkedIn DM, discovery-call script).
2. **Scope** — send `business/client-intake-questionnaire.md`; sign `business/statement-of-work-template.md`.
3. **Record** — the client records a 45-minute audio brain dump of their operational framework. Transcribe it (any transcription tool works; you just need a plain-text transcript).
4. **Generate** — run the pipeline (below). It produces the framework map, the 18-week curriculum, 18 weekly 5E pacing guides, and diagnostic screeners.
5. **QA & polish** — review `00-framework-map.md` → `gaps_to_clarify` for questions to take back to the client, then spot-edit the guides. Budget 2–4 hours of human review per engagement.
6. **Deliver** — walk through `business/delivery-checklist.md` and hand over the package.

## Running the pipeline

```bash
cd corporate-training-architect
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...

python pipeline/run_pipeline.py sample/sample_transcript.txt \
  --client "Acme Consulting" \
  --out deliverables/acme
```

Useful flags:

- `--weeks 18` — program length (default 18).
- `--dry-run` — assemble and print the prompts without calling the API (no key needed). Good for checking prompt quality before spending tokens.
- `--stage framework|outline|guides|screeners` — resume from a stage; earlier stages are loaded from the output directory if already generated.

### What it produces

```
deliverables/acme/
├── 00-framework-map.md          # Structured extraction of the expert's framework (+ JSON)
├── 01-curriculum-outline.md     # 18-week program outline: modules, weekly objectives (+ JSON)
├── weeks/
│   ├── week-01.md ... week-18.md  # 5E pacing guide per week
├── screeners/
│   ├── module-1-screener.md ... # Diagnostic screener + answer key per module
│   └── final-diagnostic.md      # End-of-program comprehension diagnostic
└── manifest.json                # Run metadata (model, timestamps, token usage)
```

### Pipeline architecture

Four stages, each building on the last:

1. **Framework extraction** — structured output (Pydantic schema) pulling the expert's core thesis, concepts, processes, heuristics, vocabulary, and *gaps to clarify* out of the raw transcript.
2. **Curriculum outline** — structured output mapping the framework onto N weeks grouped into modules, with per-week learning objectives.
3. **Weekly 5E pacing guides** — one streamed call per week (Engage / Explore / Explain / Elaborate / Evaluate). The framework map + outline are placed in a cached system prefix, so the 18 calls share one prompt cache and cost a fraction of naive re-sending.
4. **Diagnostic screeners** — one call per module plus a final program diagnostic, each with scoring rubric and answer key.

Model: `claude-opus-4-8` with adaptive thinking. A full 18-week run typically
lands in the $8–$20 API-cost range depending on transcript length — pennies
against a $5,000+ engagement. Token usage is written to `manifest.json` so you
can price with real numbers.

## Pricing at a glance

See `business/pricing-and-packaging.md` for the full ladder. Anchor offer:
**$7,500** for the complete 18-week program (transcript → delivered
curriculum, one revision round included).
