---
name: bender-preset-intake
description: Onboard a new real Line 6 Helix .hlx preset into Bender as a test fixture, discover what the parser gets wrong, and record new format evidence. Use when someone adds or shares a .hlx file.
---

# Helix preset intake

Use this when a real `.hlx` file arrives. The goal is to extract maximum format knowledge from it and leave behind permanent regression protection.

Real presets are the scarcest resource in this project. Never waste one by looking at it manually and moving on.

## 1. Place the file

Owned presets go in `presets/user/fixtures/`. Check `presets/user/README.md` before committing anything, and confirm ownership first. Never commit a preset the team does not own.

## 2. Observe before assuming

Inspect the raw bytes before running the parser:

```powershell
$f = 'presets/user/fixtures/<name>.hlx'
Get-Item $f | Select-Object Length
[System.BitConverter]::ToString((Get-Content $f -AsByteStream -TotalCount 16))
```

Record what you actually see. Do not assume the container format.

## 3. Round-trip it

```powershell
pnpm helix:roundtrip presets/user/fixtures/<name>.hlx
```

Three outcomes:

- **Parse fails** — the biggest win available. Capture the error and the smallest structural feature that caused it.
- **Parses but round trip differs** — a preservation bug. Diff output against input and identify exactly which keys/values changed.
- **Clean round trip** — good. Now check that Bender's *understanding* is right: does the reported signal chain match what the preset actually contains?

## 4. Record evidence, separated by confidence

Update `docs/helix-format-notes.md`. Keep the existing separation strictly:

- **Observed** — you saw this in a real file. Say which file and what you saw.
- **Implementation choice** — how Bender handles it, and why.
- **Hypothesis** — a pattern you suspect from one example. Mark it clearly.
- **Open question** — what more fixtures would settle.

Never promote a hypothesis to observed without a second independent example.

## 5. Add a regression case

Every intake produces at least one artifact:

- If round trip broke: add the smallest reproducing fixture plus a named test in `packages/helix`.
- If parsing was clean: add an eval case in `evals/cases/` with a realistic tone request and invariants (see the `bender-eval-case` skill).

A preset that arrives and leaves no test behind was wasted.

## 6. Report honestly

State what Bender now demonstrably handles and what remains unverified. Do not generalize from one file to "Helix compatibility". One preset proves one preset.
