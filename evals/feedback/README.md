# Feedback

What a guitarist thought after playing the preset, recorded against the run
that produced it.

```bash
pnpm eval feedback bad "harsh top end, gain went too far"
pnpm eval feedback tapping-sustain mixed "right idea, too much of it"
pnpm eval feedback --list
```

Verdicts land in `feedback.jsonl`, one JSON object per line. Unlike
`evals/results/`, this directory is committed: a judgement about a tone is
worth more than the transcript that produced it, and it does not go stale.

Each entry carries a copy of what was judged — the request, the fixture hash,
the exact before/after edits, the deployment and whether the automated checks
agreed. That means it stays meaningful after the run's transcript is deleted,
and it is what makes disagreements findable: a run that passed every check and
sounded bad is a case asserting the wrong thing.

See `evals/README.md`.
