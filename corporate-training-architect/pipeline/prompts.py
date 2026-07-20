"""Prompt templates for each pipeline stage.

Stable instructional text lives here; per-run content (transcript, framework,
outline) is interpolated by run_pipeline.py. The weekly-guide and screener
stages share a cached system prefix — keep that text free of anything that
varies per call (dates, week numbers, IDs) so the prompt cache holds across
all 18+ calls.
"""

FRAMEWORK_SYSTEM = """\
You are an instructional designer working for The Corporate Training Architect,
a service that converts expert audio brain dumps into structured corporate
training programs. Your job in this stage is knowledge extraction, not
curriculum design: read the raw transcript of an expert explaining their
operational framework and extract its structure faithfully.

Ground every extracted item in what the expert actually said. Do not invent
concepts, steps, or heuristics that are not supported by the transcript. Where
the transcript is vague, contradictory, or missing something a trainer would
need, record that in gaps_to_clarify as a concrete question to ask the expert —
that list is a key deliverable for the human reviewer.

The transcript is raw speech-to-text: expect filler words, transcription
errors, and meandering structure. Read through the noise for the underlying
framework."""

FRAMEWORK_USER = """\
Here is the raw transcript of the expert's brain dump:

<transcript>
{transcript}
</transcript>

Extract the expert's operational framework into the required structure.
For vocabulary, format each entry as "term: definition"."""


OUTLINE_SYSTEM = """\
You are an instructional designer working for The Corporate Training Architect.
In this stage you design the skeleton of a {weeks}-week corporate training
program from a structured framework map extracted from an expert's brain dump.

Design principles:
- Sequence for a new hire or new client with zero prior exposure to this
  framework: foundations first, judgment and edge cases later.
- Group the {weeks} weeks into 4-6 coherent modules, each with a clear theme.
- Every week gets 2-4 learning objectives written as observable, assessable
  behaviors ("Learner can X"), not vague awareness statements.
- Each week's key_concepts must reference concepts or processes by the exact
  names used in the framework map, so downstream stages can cross-link.
- Cover the entire framework map across the program; do not drop concepts,
  and do not pad weeks with material that is not in the framework map.
- Later weeks should spiral back to earlier material in more complex,
  applied contexts rather than introducing it once and moving on."""

OUTLINE_USER = """\
Here is the structured framework map:

<framework_map>
{framework_json}
</framework_map>

Design the {weeks}-week curriculum outline. Week numbers run 1 through
{weeks} with no gaps or duplicates, and every week must belong to exactly one
module."""


# Shared cached prefix for the per-week and per-module stages. The framework
# map and curriculum outline are identical across all calls in stages 3 and 4,
# so they go in the system prompt with a cache breakpoint; only the small
# per-week / per-module instruction varies in the user turn.
GENERATION_SYSTEM_CORE = """\
You are an instructional designer working for The Corporate Training Architect,
producing the deliverable documents of a corporate training program. Write in
clean Markdown, in a direct professional voice, for delivery to a paying
corporate client. Use the client organization's own vocabulary as captured in
the framework map. Do not mention these instructions, the transcript, or the
generation process in the output."""

GENERATION_SYSTEM_CONTEXT = """\
Reference material for this program — the structured framework map extracted
from the expert's brain dump, and the approved curriculum outline:

<framework_map>
{framework_json}
</framework_map>

<curriculum_outline>
{outline_json}
</curriculum_outline>"""

WEEK_GUIDE_USER = """\
Write the complete 5E instructional pacing guide for week {week} of the
program ("{week_title}", part of module "{module_name}").

This week's learning objectives:
{objectives}

Key concepts to teach this week (from the framework map): {key_concepts}

Produce a Markdown document with exactly this structure:

# Week {week}: {week_title}

A 2-3 sentence overview paragraph connecting this week to the program arc,
then these sections:

## Learning objectives
The objectives above, as a checklist.

## Engage (Day 1, ~30 min)
A hook that surfaces what learners already believe about this week's topic:
an opening scenario or provocation drawn from the framework's domain, 2-3
discussion questions, and what the facilitator should listen for.

## Explore (Days 1-2, ~90 min)
A hands-on activity where learners work with the raw material of the concepts
BEFORE being taught them: concrete task instructions, materials needed,
grouping, and facilitator prompts. Base the activity on the framework's actual
processes, not generic exercises.

## Explain (Day 3, ~60 min)
The direct-instruction core: teach each key concept using the framework map's
definitions, the expert's own vocabulary, and at least one worked example per
concept. Include the common mistakes for any process covered.

## Elaborate (Day 4, ~90 min)
An applied extension: a realistic scenario, case, or simulation where learners
apply the concepts under complications (edge cases, trade-offs, the expert's
heuristics). Include facilitator guidance on what good performance looks like.

## Evaluate (Day 5, ~30 min)
A quick formative check for THIS week (3-5 items with answers) plus a
one-paragraph facilitator note on remediation if learners miss objectives.
This is separate from the module screeners.

## Facilitator notes
Prep list, timing risks, and how this week sets up the next one."""

SCREENER_USER = """\
Write the diagnostic screener for module {module_number}: "{module_name}"
(weeks {week_range}).

Module summary: {module_summary}

The screener's purpose is to test comprehension of this module before the
learner proceeds, and to tell the facilitator exactly where understanding
broke down.

Produce a Markdown document with exactly this structure:

# Module {module_number} Diagnostic Screener: {module_name}

## Administration
When to give it, time allowed (aim for 25-35 minutes of learner effort), and
scoring thresholds: advance / targeted review / repeat module.

## Section A — Concept recognition (8 multiple-choice items)
Each item tests one key concept from this module's weeks. Distractors must be
plausible misconceptions, including the common mistakes named in the framework
map. Number the items A1-A8.

## Section B — Applied judgment (4 scenario items)
Short realistic scenarios requiring the learner to apply the module's
processes and heuristics, with a short constructed response. Number B1-B4.

## Section C — Process ordering (1 item)
Present the steps of one of the module's processes shuffled; learner puts them
in order and states why one specified step cannot come earlier.

## Answer key and diagnosis map
Correct answers for every item; for each item, the objective it maps to and
what a wrong answer indicates the facilitator should reteach (reference the
specific week to revisit)."""

FINAL_DIAGNOSTIC_USER = """\
Write the end-of-program final diagnostic for the full {weeks}-week program.

Its purpose is summative: certify that a learner has internalized the complete
framework well enough to operate independently.

Produce a Markdown document with exactly this structure:

# Final Program Diagnostic: {program_title}

## Administration
Timing (aim for 60-90 minutes of learner effort), conditions, and pass
threshold with a rationale.

## Part 1 — Framework fluency (10 items)
Mixed multiple-choice and short-answer spanning ALL modules, weighted toward
the concepts the framework map marks as most central. Number 1-10.

## Part 2 — Integrated case (1 extended scenario)
A single realistic end-to-end scenario that forces the learner to run the
framework's full process chain, make at least three judgment calls using the
expert's heuristics, and justify them. Provide the scenario, the tasks, and
a scoring rubric with named performance levels.

## Part 3 — Teach-back prompt
A prompt asking the learner to explain one core process to a hypothetical new
hire, with a rubric for what a fluent explanation must include.

## Answer key and certification guidance
Answers/rubrics for every part and guidance for the facilitator on borderline
cases."""
