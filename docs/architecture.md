# Bender architecture

This describes how Bender is put together and, more usefully, **why** — the decisions that are not obvious from reading the code, and the ones a future contributor is most likely to want to reverse.

## Shape

```
  apps/web  ──HTTP──▶  apps/server  ──Responses API──▶  Azure OpenAI
                            │
                            ├──▶  packages/tone-tools   the nine operations
                            │           │
                            └──────────▶ packages/helix  parse / serialize / validate

  evals  ──────────────────▶  drives the same server code with recorded or live models
```

Four packages and a harness. The dependency direction is strictly one-way: `helix` knows nothing about tools, `tone-tools` knows nothing about the model, and `server` knows nothing about the UI.

That matters because it is what makes the model swappable. `ModelProvider` is an interface; `AzureOpenAIProvider` implements it; the agent loop depends only on the interface. The eval harness substitutes a provider that replays a canned transcript, and nothing else in the system notices.

---

## `packages/helix` — the preset engine

### Lexeme preservation

The single most important decision in the codebase.

Real `.hlx` files come from at least three different writers, using different spacing and different float precision. Roughly 89% of the files we have use one-space `" : "` separators; others use two-space with 17 significant digits; others are minified. If we parsed to plain JavaScript values and re-emitted with `JSON.stringify`, every save would rewrite the entire file, and a one-parameter edit would produce a diff thousands of lines long. Worse, float round-tripping would silently alter values the user never touched.

So the parser keeps the **raw source text of every scalar** alongside its decoded value. The serializer emits that raw text verbatim for anything untouched, and measures the writer's style from the source bytes rather than picking one.

When a value *is* changed, `jsonNumberLike(template, value)` preserves the shape of what it replaced: `0.62` edited to `0.8` is written `0.80`, not `0.8`. Two decimal places in, two decimal places out.

The result is that `parse → serialize` is byte-exact on an untouched preset, and a single edit produces a single-line diff. Both properties are tested.

### What is modelled, and what is not

A typed layer sits over the raw document covering blocks, models, parameters, bypass state, routing, snapshots and controller assignments. Everything else is preserved but not interpreted.

That is deliberate. `commandFS*`, `@fs_ledcolor` and `@fs_index` have semantics we do not know. Rather than guess, we carry them through untouched — so a preset using features Bender does not understand still survives an edit to one it does.

### Sharp edges

Three things about the format that produce real bugs:

**Values are not normalized.** `HighCut` is in Hz, `threshold` in dB, `@tempo` in BPM. Parameters are a tagged union rather than a bare `number` for this reason. A live run confirmed the model reads this correctly, rolling a cab `HighCut` from 20100 to 10000 — but that is one observation, not a guarantee.

**Snapshot state is duplicated.** `snapshotN.blocks[dsp][slot]` and `snapshotN.controllers[...]["@value"]` both mirror the active snapshot. Any bypass or snapshot-controlled edit must write both. A preset with only one updated loads fine and behaves wrongly, which is the worst failure mode available.

**Position is independent of key.** Routing is `@path` (0 = A, 1 = B) plus `@position` — an index *within that branch*. In our own fixture, `block0` sits at position 2. Anything that assumes `blockN` is the Nth block in the chain will render a confidently wrong signal chain.

Full evidence, separated into observed facts, implementation choices and hypotheses, is in [`helix-format-notes.md`](helix-format-notes.md).

---

## `packages/tone-tools` — the constrained operations

The model cannot write Helix JSON. It gets nine operations:

| | |
|---|---|
| `inspect_preset` | Name, device, firmware, tempo, snapshot summary |
| `inspect_signal_chain` | Blocks in signal order, with bypass state |
| `inspect_block` | Every parameter of one block, with ranges |
| `compare_presets` | What has changed so far this session |
| `set_parameter` | Set one parameter to an absolute value |
| `adjust_parameter` | Move one parameter by a relative amount |
| `enable_block` / `disable_block` | Bypass state |
| `undo_last_change` | Revert the most recent edit |

### What is deliberately absent

No whole-document write. No block add, remove, reorder or replace. No routing change.

Adding a block means choosing a position, a DSP assignment, a model identifier and a complete default parameter set. Getting any of them wrong produces a file that fails to load on hardware — and the model has no way to verify that. Parameter edits and bypass are enough to answer almost every tone request, and they cannot produce a structurally invalid preset.

This is also a product decision, not only a safety one. Asked to swap an amp model, Bender declines and explains rather than approximating one with tone controls. A tool that quietly does something adjacent to what you asked, and reports success, is worse than one that says no.

### Transactional edits

Every mutation clones the document, applies the change, validates the result, and then either keeps or discards it. A failed validation leaves the session untouched rather than partially modified.

Validation distinguishes **warnings** from **hard failures**. An unrecognised device is a warning — parse anyway, tell the user. A parameter outside its declared range is a failure.

Ranges come from the preset's own `controller[dspN][slot][param]` entries, which are the only in-file source of real bounds. Where no range is declared we do not invent one.

### Undo restores snapshots, not inverses

Undo keeps a serialized copy of the document before each edit and restores it, rather than computing an inverse operation.

This is more memory and less cleverness, and it is correct in cases where an inverse is not. Bypassing a block writes to two places because of the snapshot duplication described above; an "inverse bypass" would have to know that. Restoring bytes does not have to know anything.

---

## `apps/server` — orchestration

### The system prompt contains almost no tone advice

The most contestable decision here, so it is worth stating plainly.

The prompt covers **method**: inspect before editing, find the cause in this specific chain, make the smallest change that addresses it, respect constraints the user stated. It does not contain tone recipes. There is no table mapping "sustain" to "compressor".

The brief for this project asked for model intelligence over hardcoded rules, and the evidence supports it. Asked for sustain without added noise, the model inspected the amp and reached for power-amp sag and bias — a better and more contextual answer than any rule table would have produced, and one that depended on the specific blocks present in that chain.

The corollary is that **safety cannot live in the prompt**. A prompt *requests* good behaviour; the tool layer *enforces* it. Every constraint that matters — valid ranges, structural integrity, preserved unknowns, transactional application — is code.

### Instructions are rebuilt every iteration

Tools change the preset underneath the conversation. If the model's context still describes the preset as it was three tool calls ago, it reasons about values it has already changed.

So the instructions are regenerated from the live preset on every loop iteration rather than assembled once per turn.

### Responses API specifics

Verified against the live endpoint:

- `input` is a **flat array**. Tool calls and their results are siblings at the top level — `{type:'function_call', call_id, name, arguments}` and `{type:'function_call_output', call_id, output}` — not nested inside an assistant message.
- Output items are `reasoning`, `message` and `function_call`. **Reasoning items are dropped deliberately.** Raw chain-of-thought does not reach the UI.
- The API auto-applies `strict: true` to function tools. We send `strict: false` explicitly, because our own `validateArgs` produces *correctable* errors that name the bad argument and list valid alternatives — something a model can recover from within the same turn. Provider-side strict rejection is opaque by comparison.

### Retries distinguish transient from permanent

Rate limits, 5xx responses and network errors retry with exponential backoff. Authentication failures, 404s and malformed requests fail immediately — retrying into the same wall wastes the user's time and obscures the actual problem.

`translateError` turns provider errors into actionable messages. The two that matter:

- **403 `AuthenticationTypeDisabled`** — key auth is disabled on the R&D resource. Use Entra ID (`az login`). This is the default for exactly this reason.
- **404 `DeploymentNotFound`** — the `model` field takes a *deployment* name, not a model name.

Both cost real debugging time before they were diagnosed, so both are surfaced as hints rather than raw status codes.

### Logging

`redact()` scrubs by key name **and by shape**: any 60+ character alphanumeric run, `Bearer …`, and `eyJ…`. Shape matters more than names, because credentials usually reach logs inside error messages rather than in a field helpfully called `apiKey`.

Preset contents are redacted too. A user's preset is their work.

### Sessions are in memory

`store.ts` holds state in a `Map`. This makes the server single-instance — two replicas would drop sessions on roughly half of all requests. Documented in the file, and called out as a constraint on any hosting decision.

---

## `apps/web` — the workspace

A Vite/React/Tailwind app inherited from this repository's previous life, with the product code replaced. The framework setup, undo middleware, toast, dialog, focus trap and resizable panel hook were all worth keeping; none of them were specific to video editing.

Uploads are parsed **client-side first** via `@bender/helix`, for instant feedback and to reject an obviously invalid file before a network round trip. The server is the source of truth for everything after that.

**No Azure credential, endpoint or SDK exists anywhere in the frontend.** The production build is scanned to confirm it.

---

## `evals` — the harness

Built for the stage that follows this one: a real preset collection arrives, we run Bender against it, and we fix what breaks.

A case pairs a fixture with a request and the invariants that must hold. Runs capture the fixture's SHA-256, the parse result, the full transcript, every before/after value, the round-trip verdict and the explanation.

Cases carrying a recorded transcript replay it instead of calling the model, which pins the preset engine and tool layer deterministically for CI while leaving the model's judgement to live cases.

**Assertions favour `mustNotChange` over exact values.** Almost any edit produces a tone change, so asserting that something moved mostly proves the model did something. Asserting that the gain did *not* move is what tests whether "without making it noisy" was actually honoured. Pinning exact values would encode one model's taste as correctness, and every prompt improvement would surface as a regression.

See [`../evals/README.md`](../evals/README.md).

---

## Things a future contributor should know

**Do not "simplify" the parser to use `JSON.parse`/`JSON.stringify`.** It will look like a large cleanup and it will silently break round-trip safety for every preset not written in our own style.

**Do not move safety into the prompt.** If a new constraint matters, it belongs in `tone-tools` where it is enforced.

**Do not add a tone rule table.** If Bender gives a bad answer, the fix is better context, a better tool description, or a better model — not a hardcoded mapping. Add an eval case first so you can tell whether you improved anything.

**Check both snapshot locations** when touching bypass or snapshot-controlled parameters.

**`ParameterDiff` has no `block` field.** It is `{dsp, slot, label, parameter, before, after}`. Build the id as `${dsp}/${slot}`.
