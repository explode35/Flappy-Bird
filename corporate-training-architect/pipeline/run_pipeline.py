#!/usr/bin/env python3
"""The Corporate Training Architect — transcript-to-curriculum pipeline.

Usage:
    python run_pipeline.py <transcript.txt> --client "Acme Consulting" --out deliverables/acme

Stages (each writes its output to disk before the next stage starts, so you
can resume with --stage if something fails partway through):

    1. framework  -> 00-framework-map.md / .json
    2. outline    -> 01-curriculum-outline.md / .json
    3. guides     -> weeks/week-NN.md  (one per week)
    4. screeners  -> screeners/module-N-screener.md + final-diagnostic.md

Model: claude-opus-4-8 with adaptive thinking. Stages 3 and 4 share a cached
system prefix (the framework map + curriculum outline) so an 18-week run
re-uses one prompt cache instead of re-sending ~5-10K tokens of context on
every call.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from pydantic import ValidationError

import prompts
from schemas import CurriculumOutline, FrameworkMap

MODEL = "claude-opus-4-8"


def log(msg: str) -> None:
    print(f"[pipeline] {msg}", file=sys.stderr)


def _client():
    import anthropic

    return anthropic.Anthropic()


# ---------------------------------------------------------------------------
# Token/cost bookkeeping
# ---------------------------------------------------------------------------


class UsageTracker:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def record(self, stage: str, usage) -> None:
        self.calls.append(
            {
                "stage": stage,
                "input_tokens": getattr(usage, "input_tokens", 0),
                "output_tokens": getattr(usage, "output_tokens", 0),
                "cache_creation_input_tokens": getattr(
                    usage, "cache_creation_input_tokens", 0
                )
                or 0,
                "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0)
                or 0,
            }
        )

    def totals(self) -> dict[str, int]:
        keys = [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ]
        return {k: sum(c[k] for c in self.calls) for k in keys}


# ---------------------------------------------------------------------------
# Stage 1: framework extraction
# ---------------------------------------------------------------------------


def run_framework_stage(
    client, transcript: str, out_dir: Path, tracker: UsageTracker, dry_run: bool
) -> FrameworkMap:
    system = prompts.FRAMEWORK_SYSTEM
    user = prompts.FRAMEWORK_USER.format(transcript=transcript)

    if dry_run:
        log("DRY RUN — framework stage prompt:")
        print("--- system ---\n" + system + "\n--- user ---\n" + user[:2000])
        return FrameworkMap(
            expert_name="[dry-run]",
            domain="[dry-run]",
            framework_name="[dry-run]",
            core_thesis="[dry-run]",
            target_learner="[dry-run]",
            concepts=[],
            processes=[],
            heuristics=[],
            vocabulary=[],
            gaps_to_clarify=[],
        )

    log("Stage 1/4: extracting framework map from transcript...")
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=FrameworkMap,
    )
    tracker.record("framework", response.usage)
    framework = response.parsed_output
    if framework is None:
        raise RuntimeError(
            "Framework extraction did not return parsed output "
            f"(stop_reason={response.stop_reason})"
        )

    (out_dir / "00-framework-map.json").write_text(
        framework.model_dump_json(indent=2)
    )
    (out_dir / "00-framework-map.md").write_text(render_framework_md(framework))
    log("  -> 00-framework-map.md / .json written")
    return framework


def render_framework_md(fw: FrameworkMap) -> str:
    lines = [
        f"# Framework Map: {fw.framework_name}",
        "",
        f"**Expert:** {fw.expert_name}  ",
        f"**Domain:** {fw.domain}  ",
        f"**Target learner:** {fw.target_learner}",
        "",
        "## Core thesis",
        fw.core_thesis,
        "",
        "## Concepts",
    ]
    for c in fw.concepts:
        lines += [
            f"### {c.name}",
            c.definition,
            f"*Why it matters:* {c.why_it_matters}",
            f"> {c.source_quote}",
            "",
        ]
    lines.append("## Processes")
    for p in fw.processes:
        lines += [
            f"### {p.name}",
            p.description,
            f"- **Inputs:** {', '.join(p.inputs)}",
            f"- **Outputs:** {', '.join(p.outputs)}",
            f"- **Common mistakes:** {', '.join(p.common_mistakes) or 'none noted'}",
            "",
        ]
    lines.append("## Heuristics")
    lines += [f"- {h}" for h in fw.heuristics]
    lines.append("")
    lines.append("## Vocabulary")
    lines += [f"- {v}" for v in fw.vocabulary]
    lines.append("")
    lines.append("## Gaps to clarify with the expert")
    lines += [f"- [ ] {g}" for g in fw.gaps_to_clarify] or ["- (none identified)"]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Stage 2: curriculum outline
# ---------------------------------------------------------------------------


def run_outline_stage(
    client,
    framework: FrameworkMap,
    weeks: int,
    out_dir: Path,
    tracker: UsageTracker,
    dry_run: bool,
) -> CurriculumOutline:
    system = prompts.OUTLINE_SYSTEM.format(weeks=weeks)
    user = prompts.OUTLINE_USER.format(
        framework_json=framework.model_dump_json(indent=2), weeks=weeks
    )

    if dry_run:
        log("DRY RUN — outline stage prompt:")
        print("--- system ---\n" + system + "\n--- user (truncated) ---\n" + user[:1000])
        return CurriculumOutline(
            program_title="[dry-run]",
            audience="[dry-run]",
            program_promise="[dry-run]",
            modules=[],
            weeks=[],
        )

    log(f"Stage 2/4: designing {weeks}-week curriculum outline...")
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=CurriculumOutline,
    )
    tracker.record("outline", response.usage)
    outline = response.parsed_output
    if outline is None:
        raise RuntimeError(
            "Outline generation did not return parsed output "
            f"(stop_reason={response.stop_reason})"
        )

    _validate_outline(outline, weeks)

    (out_dir / "01-curriculum-outline.json").write_text(
        outline.model_dump_json(indent=2)
    )
    (out_dir / "01-curriculum-outline.md").write_text(render_outline_md(outline))
    log("  -> 01-curriculum-outline.md / .json written")
    return outline


def _validate_outline(outline: CurriculumOutline, weeks: int) -> None:
    week_numbers = sorted(w.week for w in outline.weeks)
    expected = list(range(1, weeks + 1))
    if week_numbers != expected:
        log(
            f"  WARNING: outline week numbers {week_numbers} do not exactly match "
            f"1..{weeks}. Downstream generation will use whatever the model "
            "produced — review 01-curriculum-outline.md before proceeding."
        )


def render_outline_md(outline: CurriculumOutline) -> str:
    lines = [
        f"# {outline.program_title}",
        "",
        f"**Audience:** {outline.audience}",
        "",
        f"**Program promise:** {outline.program_promise}",
        "",
        "## Modules",
        "",
    ]
    weeks_by_num = {w.week: w for w in outline.weeks}
    for m in outline.modules:
        lines.append(f"### Module {m.number}: {m.name}")
        lines.append(m.summary)
        lines.append("")
        lines.append("| Week | Title | Objectives |")
        lines.append("|---|---|---|")
        for wn in m.week_numbers:
            w = weeks_by_num.get(wn)
            if w:
                objs = "; ".join(w.objectives)
                lines.append(f"| {w.week} | {w.title} | {objs} |")
        lines.append("")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Stage 3: weekly 5E pacing guides
# ---------------------------------------------------------------------------


def run_guides_stage(
    client,
    framework: FrameworkMap,
    outline: CurriculumOutline,
    out_dir: Path,
    tracker: UsageTracker,
    dry_run: bool,
) -> None:
    weeks_dir = out_dir / "weeks"
    weeks_dir.mkdir(exist_ok=True)

    system = [
        {"type": "text", "text": prompts.GENERATION_SYSTEM_CORE},
        {
            "type": "text",
            "text": prompts.GENERATION_SYSTEM_CONTEXT.format(
                framework_json=framework.model_dump_json(indent=2),
                outline_json=outline.model_dump_json(indent=2),
            ),
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        },
    ]

    week_to_module = {}
    for m in outline.modules:
        for wn in m.week_numbers:
            week_to_module[wn] = m.name

    log(f"Stage 3/4: generating {len(outline.weeks)} weekly 5E pacing guides...")
    for i, w in enumerate(outline.weeks, start=1):
        out_path = weeks_dir / f"week-{w.week:02d}.md"
        if out_path.exists() and not dry_run:
            log(f"  [{i}/{len(outline.weeks)}] week {w.week} already exists, skipping")
            continue

        user = prompts.WEEK_GUIDE_USER.format(
            week=w.week,
            week_title=w.title,
            module_name=week_to_module.get(w.week, w.module_name),
            objectives="\n".join(f"- {o}" for o in w.objectives),
            key_concepts=", ".join(w.key_concepts),
        )

        if dry_run:
            log(f"  DRY RUN week {w.week}: would call model")
            continue

        with client.messages.stream(
            model=MODEL,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": user}],
        ) as stream:
            text = "".join(stream.text_stream)
            final = stream.get_final_message()
        tracker.record(f"week-{w.week}", final.usage)
        out_path.write_text(text.strip() + "\n")
        log(f"  [{i}/{len(outline.weeks)}] week {w.week} -> {out_path.name}")


# ---------------------------------------------------------------------------
# Stage 4: diagnostic screeners
# ---------------------------------------------------------------------------


def run_screeners_stage(
    client,
    framework: FrameworkMap,
    outline: CurriculumOutline,
    weeks: int,
    out_dir: Path,
    tracker: UsageTracker,
    dry_run: bool,
) -> None:
    screeners_dir = out_dir / "screeners"
    screeners_dir.mkdir(exist_ok=True)

    system = [
        {"type": "text", "text": prompts.GENERATION_SYSTEM_CORE},
        {
            "type": "text",
            "text": prompts.GENERATION_SYSTEM_CONTEXT.format(
                framework_json=framework.model_dump_json(indent=2),
                outline_json=outline.model_dump_json(indent=2),
            ),
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        },
    ]

    log(f"Stage 4/4: generating {len(outline.modules)} module screeners + final diagnostic...")
    for m in outline.modules:
        out_path = screeners_dir / f"module-{m.number}-screener.md"
        if out_path.exists() and not dry_run:
            log(f"  module {m.number} screener already exists, skipping")
            continue

        wns = sorted(m.week_numbers)
        week_range = f"{wns[0]}-{wns[-1]}" if len(wns) > 1 else str(wns[0]) if wns else "?"
        user = prompts.SCREENER_USER.format(
            module_number=m.number,
            module_name=m.name,
            week_range=week_range,
            module_summary=m.summary,
        )

        if dry_run:
            log(f"  DRY RUN module {m.number} screener: would call model")
            continue

        with client.messages.stream(
            model=MODEL,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": user}],
        ) as stream:
            text = "".join(stream.text_stream)
            final = stream.get_final_message()
        tracker.record(f"screener-module-{m.number}", final.usage)
        out_path.write_text(text.strip() + "\n")
        log(f"  module {m.number} screener -> {out_path.name}")

    final_path = screeners_dir / "final-diagnostic.md"
    if not final_path.exists() or dry_run:
        user = prompts.FINAL_DIAGNOSTIC_USER.format(
            weeks=weeks, program_title=outline.program_title
        )
        if dry_run:
            log("  DRY RUN final diagnostic: would call model")
        else:
            with client.messages.stream(
                model=MODEL,
                max_tokens=8000,
                system=system,
                messages=[{"role": "user", "content": user}],
            ) as stream:
                text = "".join(stream.text_stream)
                final = stream.get_final_message()
            tracker.record("final-diagnostic", final.usage)
            final_path.write_text(text.strip() + "\n")
            log("  final diagnostic -> final-diagnostic.md")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript", type=Path, help="Path to the raw transcript (.txt)")
    parser.add_argument("--client", required=True, help="Client/expert name, for the manifest")
    parser.add_argument("--out", required=True, type=Path, help="Output directory")
    parser.add_argument("--weeks", type=int, default=18, help="Program length in weeks")
    parser.add_argument(
        "--stage",
        choices=["framework", "outline", "guides", "screeners"],
        default="framework",
        help="Stage to start from (earlier stages are loaded from --out if present)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Assemble and print prompts without calling the API",
    )
    args = parser.parse_args()

    if not args.transcript.exists():
        parser.error(f"transcript not found: {args.transcript}")

    args.out.mkdir(parents=True, exist_ok=True)
    transcript = args.transcript.read_text()

    tracker = UsageTracker()
    client = None if args.dry_run else _client()

    started = time.time()

    # Stage 1
    fw_json_path = args.out / "00-framework-map.json"
    if args.stage == "framework" or not fw_json_path.exists():
        framework = run_framework_stage(client, transcript, args.out, tracker, args.dry_run)
    else:
        log("Loading existing framework map...")
        framework = FrameworkMap.model_validate_json(fw_json_path.read_text())

    # Stage 2
    outline_json_path = args.out / "01-curriculum-outline.json"
    if args.stage in ("framework", "outline") or not outline_json_path.exists():
        outline = run_outline_stage(
            client, framework, args.weeks, args.out, tracker, args.dry_run
        )
    else:
        log("Loading existing curriculum outline...")
        outline = CurriculumOutline.model_validate_json(outline_json_path.read_text())

    # Stage 3
    if args.stage in ("framework", "outline", "guides"):
        run_guides_stage(client, framework, outline, args.out, tracker, args.dry_run)

    # Stage 4
    run_screeners_stage(
        client, framework, outline, args.weeks, args.out, tracker, args.dry_run
    )

    elapsed = time.time() - started
    manifest = {
        "client": args.client,
        "model": MODEL,
        "weeks": args.weeks,
        "elapsed_seconds": round(elapsed, 1),
        "usage_totals": tracker.totals(),
        "usage_by_call": tracker.calls,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2))

    totals = tracker.totals()
    log(f"Done in {elapsed:.1f}s. Token usage: {totals}")
    log(f"Deliverables written to: {args.out.resolve()}")


if __name__ == "__main__":
    try:
        main()
    except ValidationError as e:
        log(f"Schema validation error: {e}")
        sys.exit(1)
