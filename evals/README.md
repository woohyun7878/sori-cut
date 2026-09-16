# Bender evaluation harness

This is the loop we will spend most of our time in once real `.hlx` files
arrive. It exists to make one thing cheap: **turning a preset that Bender got
wrong into a test that stops it happening again.**

It is not a benchmark. Nobody needs a score. What we need is to run twenty real
presets through Bender, see which ones break, and know tomorrow whether we fixed
them without breaking the other nineteen.

## The loop

```
  drop a real .hlx into presets/user/fixtures/
      ↓
  write a case describing what you asked for and what must be true
      ↓
  pnpm eval <case>                    ← live model, real Azure call
      ↓
  read the transcript in evals/results/
      ↓
  fix the parser / tool / prompt / schema knowledge
      ↓
  pnpm eval --mock                    ← fast, deterministic, no network
```

Only the last step belongs in CI. Live cases call a real model and will
legitimately vary between runs.

## Running

```bash
pnpm eval                 # every case, live model
pnpm eval --mock          # only cases with a recorded transcript; no network
pnpm eval tapping-sustain # one case by id (prefix match works)
pnpm eval --list          # what exists, and which are mockable
pnpm eval --verbose       # print the full tool transcript as it runs
pnpm eval --record        # keep the generated preset even when a case passes
```

Live runs need Azure configured exactly as the server does — see
`apps/server/.env.example`. The harness reads `apps/server/.env` and
`.env.local` through the same loader the server uses, so a local run uses the
dev deployment configured there, not production. **Key auth is disabled on the
dev resource**; use Entra ID (`az login`). The harness says so rather than
failing obscurely.

Every run writes a JSON file to `evals/results/` containing the fixture's
SHA-256, the parse result, the full model/tool transcript, every before/after
value, the round-trip verdict and the final explanation. Those files are the
point — when something regresses, diff two of them.

## What it cost

Every run prints what it spent: tokens in and out, reasoning tokens, model
turns, tool calls, and tokens per edit actually landed.

```
2/2 passed (14.3s)
18.4k tokens, 16.1k in, 2.3k out, 1.8k reasoning — 0.0041 USD
5 model turn(s), 9 tool call(s), 3 edit(s), 6.1k tokens/edit
```

A run that passes every check by making nine tool calls and burning 18k tokens
is not a good run, and pass/fail alone would never tell you. **Tokens per edit**
is the number to drive down.

For the dollar figure, set per-million-token prices from the Azure pricing page:

```bash
BENDER_PRICE_INPUT_PER_1M=0.15
BENDER_PRICE_OUTPUT_PER_1M=0.60
BENDER_PRICE_CURRENCY=USD      # optional
```

Without them the token counts still print. Prices are not hardcoded because
they vary by model, region and deployment type, and a table in this repo would
go stale silently. Note that reasoning tokens are a *subset* of output tokens,
not an addition — they are billed once.

## Recording what you heard

The checks cannot tell you it sounded thin. Play the preset, then record the
verdict against the run:

```bash
pnpm eval feedback bad "harsh top end, gain went too far"
pnpm eval feedback tapping-sustain mixed "right idea, too much of it"
pnpm eval feedback --list
```

With no case id it judges the most recent run, which is the one you just
played. Verdicts are `good`, `bad` or `mixed` — `mixed` exists because "right
idea, too much of it" is the common case and flattening it to `bad` loses the
useful half.

Feedback lands in `evals/feedback/feedback.jsonl` and **is committed**, unlike
`evals/results/`. It carries a copy of the request, the fixture hash and the
exact edits, so it stays meaningful after the transcript is pruned. That record
is the raw material for tuning prompts and for building examples of what good
actually sounds like.

`--list` flags runs where the checks and your ears disagreed. A run that passed
every check and sounded bad means the case asserts the wrong thing; one that
failed and sounded fine means the checks are too strict. Both are bugs in the
harness, and both are invisible without this.

## Writing a case

A case is a JSON file in `evals/cases/`. The minimum is a fixture, a request,
and what must be true afterwards:

```json
{
  "id": "harsh-pick-attack",
  "fixture": "presets/user/fixtures/my-lead.hlx",
  "request": "The pick attack is harsh.",
  "expect": {
    "outcome": "edits",
    "mustNotChange": [{ "block": "dsp0/block1", "parameter": "Drive" }],
    "maxEdits": 4
  }
}
```

### What you can assert

| Field | What it catches |
|---|---|
| `outcome` | `edits`, `no-edits`, `refusal`, or `error`. A refusal case that edits the preset fails. |
| `mustNotChange` | The collateral damage check. This is the most valuable one — see below. |
| `mustChange` | A parameter that has to move, optionally with `direction` and a `min`/`max` bound. |
| `blocksUntouched` | Whole blocks that must be left alone. |
| `maxEdits` | Catches a model that rewrote half the preset to answer one question. |
| `roundTrip` | On by default. The output must reparse to the same thing. |
| `allToolCallsSucceed` | Catches a model flailing against the tool layer and recovering by luck. |
| `replyMentions` | Phrases the explanation must contain. Punctuation and markdown are normalized. |

**`mustNotChange` is where the real signal is.** Almost any edit produces *a*
tone change; the interesting question is whether Bender respected the
constraint. "More sustain without more noise" is only answered correctly if the
gain really did not move. Prefer asserting what must have stayed still over
asserting exact values — pinning `Master` to `0.48` tests one model's taste, not
Bender's correctness.

### Deterministic cases

Add a `mock` array and the case can run without a network:

```json
"mock": [
  { "toolCalls": [{ "name": "set_parameter",
                    "arguments": { "block": "dsp0/block1",
                                   "parameter": "Master", "value": 0.48 } }] },
  { "text": "I brought the amp master up." }
]
```

The transcript is replayed in order in place of the model. This pins the *tool
layer and preset engine* deterministically while leaving the model's judgement
to live cases. When a live run reveals a parser or tool bug, capture it this way
— that is the regression test. The run's JSON in `evals/results/` has the tool
calls and arguments to copy from.

## Fixtures

Cases may reference:

- `packages/helix/test/fixtures/` — the small legally-clear set used by unit tests
- `presets/user/fixtures/` — **your own** presets, for real-world coverage

The second directory is gitignored by default. Do not commit presets you do not
own the rights to redistribute, and do not commit a customer's work without
asking. A case referencing a missing fixture fails at load time with the path,
rather than silently skipping.

## What this harness does not do

It does not score tone quality. It cannot — whether a lead tone is *good* is a
judgement call, and automating it would mean encoding exactly the hardcoded tone
opinions Bender is built to avoid. Record human verdicts with
`pnpm eval feedback` instead, and keep the automated checks on things that are
actually decidable: did it corrupt the preset, did it respect the constraint,
did it stay in scope.
