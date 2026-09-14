---
name: bender-eval-case
description: Turn an observed Bender failure into a replayable evaluation case or regression test in evals/. Use when Bender mishandles a tone request, corrupts or mis-parses a preset, or makes a poor editing decision.
---

# Turning a failure into an eval case

Bender improves through a tight loop: real preset -> real request -> observed failure -> permanent case. This skill covers the "permanent case" step.

## 1. Classify the failure first

The class determines where the fix goes and what kind of case to write.

| Class | Symptom | Case type |
|---|---|---|
| Parse | File rejected or misread | Unit fixture test in `packages/helix` |
| Round trip | Output differs semantically from input | Preservation test in `packages/helix` |
| Tool rejection | A valid edit was refused | Eval case + tool schema fix |
| Tool corruption | An edit produced an invalid preset | **Critical.** Corruption test in `packages/tone-tools` |
| Model choice | Edit was valid but musically wrong or overreaching | Eval case with invariants |
| Explanation | Edit was right, explanation wrong or misleading | Eval case with notes |

Parse, round-trip, and corruption failures are deterministic — write them as ordinary unit tests, not eval cases. Only model-in-the-loop behavior belongs in `evals/`.

## 2. Write the case

Add a file under `evals/cases/<descriptive-failure-name>.json` following the schema in `evals/README.md`.

Name it after the failure, not the feature: `swaps-amp-when-asked-for-sustain` is a good name; `eval-12` is not.

Fill in:

- `fixture` — path to the preset. Reference it; never inline it.
- `request` — the exact user wording that triggered the failure.
- `invariants` — what must hold no matter how the model solves it. **This is the field that matters.**
- `untouched` — blocks/parameters that must not change. This is how you catch collateral damage.
- `expect` — optional soft expectations. Prefer direction and range over exact values.
- `outcome` — `success`, or an expected refusal/warning.
- `notes` — why this case exists, in one or two sentences. Future-you needs this.

## 3. Calibrate specificity

The most common mistake is over-specification.

- Asserting an exact parameter value will fail the next time the model makes an equally good but different choice, and the case will get deleted.
- Asserting nothing means the case passes while Bender is broken.

Aim for: *"the preset still parses, block count is unchanged, the amp model was not swapped, and the compressor's sustain moved up."*

## 4. Confirm it actually fails

Run the case before the fix exists:

```powershell
pnpm eval <case-name>
```

If it passes, the case does not capture the failure. Tighten it and try again. A regression case that never failed is not a regression case.

## 5. Fix the system, not the symptom

For model-choice failures, resist adding a hardcoded tone rule. Bender's premise is that a capable model reasons about a real signal chain. Fix instead:

- the preset summary the model receives (was the relevant information visible?)
- the tool descriptions (did the model know inspection was available?)
- the inspection tools (could it see what it needed?)
- the system prompt's stated constraints (smallest effective change, preserve intent)

Safety and structural validity belong in code. Taste belongs to the model.

## 6. Verify and record

Re-run after the fix and confirm the case passes. Then run the full suite to confirm you did not regress another case:

```powershell
pnpm eval:all
```

Report real numbers. Never claim a case passes unless you ran it.
