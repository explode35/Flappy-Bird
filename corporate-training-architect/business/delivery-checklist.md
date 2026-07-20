# Delivery Checklist

Run through this for every engagement, in order. Budget 2-4 hours of human
time for a Signature (18-week) package.

## Before recording

- [ ] Deposit received
- [ ] SOW signed
- [ ] Intake questionnaire completed and reviewed
- [ ] Recording session scheduled within 14 days of deposit
- [ ] Client sent the "recording prep" prompts (Section 2 of the intake doc)

## After recording, before running the pipeline

- [ ] Transcribe the recording to plain text (any transcription tool —
      quality of transcription directly affects framework extraction
      quality; skim it once for obviously garbled sections before feeding
      it in)
- [ ] Save transcript to `sample/` or a client-specific input folder
- [ ] Confirm program length (weeks) matches what intake specified

## Running the pipeline

- [ ] `python pipeline/run_pipeline.py <transcript> --client "<name>" --out deliverables/<slug> --weeks <N>`
- [ ] Watch stage 1 output — does `00-framework-map.md` actually reflect
      what the expert said? If concepts feel thin or wrong, this is the
      cheapest point to fix it: re-run stage 1 alone, or add clarifying
      notes to the transcript and re-run.
- [ ] Read the `gaps_to_clarify` list. Anything material? Email the client
      a short list of 2-5 targeted questions rather than guessing.
- [ ] Check `01-curriculum-outline.md` — does the week sequencing make
      sense? Does every module look substantive? This is the second-
      cheapest point to catch a structural problem, before 18 weeks of
      guides get written against a bad outline.
- [ ] Let stages 3 and 4 complete.

## Human QA pass (budget ~2 hours for Signature)

- [ ] Spot-check 4-5 weekly guides across the program (not just week 1) —
      look for: does the Explain section actually use the framework map's
      real definitions and examples, not generic filler? Do activities
      make sense for this domain?
- [ ] Check that any client-provided constraints (compliance, brand voice,
      excluded topics from intake Section 3) were actually respected —
      the pipeline doesn't know about these unless you add them to the
      transcript or edit them in manually.
- [ ] Skim every screener's answer key for obviously wrong answers
- [ ] Fix expert name / company name / terminology if the model rendered
      anything generically instead of using the client's actual vocabulary
- [ ] Read the final diagnostic's integrated case — does it feel like a
      real scenario in this domain, not a generic business case?

## Packaging and delivery

- [ ] Convert to client's requested format if not Markdown (Word/PDF/Docs)
- [ ] Zip or link the full `deliverables/<slug>/` folder
- [ ] Send invoice for remaining 50%
- [ ] Schedule the 30-minute walkthrough call (Signature/Enterprise)
- [ ] Note delivery date — start the 14-day revision clock

## After delivery

- [ ] Log actual token usage from `manifest.json` for your own margin
      tracking
- [ ] Ask for a testimonial/referral once the client confirms
      satisfaction, before the revision window closes
