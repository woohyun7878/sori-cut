# Bender

> Your AI guitar tone engineer.

Bender reads a Line 6 Helix preset, shows you its signal chain, and turns a plain-English request into safe, reviewable edits.

You say what is wrong with the tone. Bender inspects the chain, works out what is causing it, changes the parameters that matter, and tells you what it did. You see every change, undo anything you disagree with, and download a working `.hlx`.

```
My tapped notes are too transient and die too quickly.
Give them more body and sustain without making the preset noisy.
```

From a real run against the live model:

> Inspected the preset and three blocks, then raised `Sag` 0.5→0.58, `Master` 0.36→0.48 and `BiasX` 0.5→0.6.
>
> *"I gave the amp more power-section bloom and a softer response... I left the preamp gain and bypassed drive untouched, so the noise floor shouldn't increase."*

It reached for power-amp sag and bias rather than simply adding gain, and it honoured the constraint it was given. That is the whole idea: a capable model reasoning about a real signal chain, rather than a lookup table mapping words to knobs.

---

## Status

A working prototype, honestly scoped.

**What works:** parsing and round-tripping `.hlx` files, a typed signal-chain model, nine constrained editing tools with validation and undo, multi-turn tool-calling orchestration against Azure OpenAI, a replayable evaluation harness, and the upload → chat → diff → undo → download path end to end.

**What is not claimed:** broad Helix compatibility. We have verified against a small fixture set. The next stage of this project is feeding Bender a real preset collection and fixing what breaks — the harness exists for exactly that. See [`docs/helix-format-notes.md`](docs/helix-format-notes.md) for what we actually established versus what we are still guessing at.

---

## How it works

```
  Browser                     Backend                      Azure OpenAI
  ───────                     ───────                      ────────────
  upload .hlx  ──────────▶  parse, open session
  see chain    ◀──────────  signal chain
  "more sustain,
   less noise"  ──────────▶  build context  ──────────────▶  reason
                             ◀──────────────────────────────  call tools
                             validate + apply
                             ────────────────────────────▶  tool results
                             ◀──────────────────────────────  (loop)
  explanation  ◀──────────  reply + diff  ◀────────────────  explain
  + diff
  undo / download ────────▶  serialize
```

The model never writes Helix JSON. It gets nine deterministic operations and nothing else.

### The parts

| Package | What it does |
|---|---|
| [`packages/helix`](packages/helix) | Parse, serialize, validate and round-trip `.hlx` files |
| [`packages/tone-tools`](packages/tone-tools) | The nine tools the model may invoke, with validation, audit trail and undo |
| [`apps/server`](apps/server) | Azure OpenAI orchestration, session state, HTTP API |
| [`apps/web`](apps/web) | The workspace UI |
| [`evals`](evals) | Replayable regression harness for real presets |

Full detail in [`docs/architecture.md`](docs/architecture.md).

---

## Running it

Requires Node 20+ and pnpm 9.

```bash
pnpm install
```

### Configure Azure OpenAI

```bash
cp apps/server/.env.example apps/server/.env
```

> [!IMPORTANT]
> **Key authentication is disabled on the R&D resource.** An `api-key` header returns
> `403 AuthenticationTypeDisabled`. Use Entra ID, which is the default:
>
> ```bash
> az login
> ```
>
> Key auth is still supported in code for when the resource setting changes — set
> `AZURE_OPENAI_API_KEY` and it will be used. If you see a 403, this is why, and the
> server's error message will tell you so.

One more trap worth knowing: `AZURE_OPENAI_DEPLOYMENT` must be a **deployment** name, not a model name. A model name returns `404 DeploymentNotFound`.

### Run

```bash
pnpm dev:server    # backend on :8787
pnpm dev           # frontend on :5173
```

Then open http://localhost:5173 and drop in a `.hlx`.

### Verify

```bash
pnpm typecheck
pnpm lint
pnpm test          # 256 tests
pnpm build
pnpm eval --mock   # deterministic evaluation cases, no network
pnpm eval          # full suite against the live model
```

---

## Helix presets

A `.hlx` file is plain UTF-8 JSON, but there are enough sharp edges that it is worth reading [`docs/helix-format-notes.md`](docs/helix-format-notes.md) before touching the parser. Three that cause real bugs:

- **Values are not normalized.** `HighCut` is in Hz (`20100`), `threshold` in dB (`-48.0`), `@tempo` in BPM. Assuming 0–1 and writing `0.5` into a `HighCut` sets a 0.5 Hz filter.
- **Snapshot data is stored twice**, in `snapshotN.blocks` and again in `snapshotN.controllers`. Write one without the other and the preset becomes quietly inconsistent — which is worse than one that fails to load.
- **A block's key is independent of its position.** Routing is `@path` plus `@position` *within that branch*; `block0` can sit third in the chain.

The parser is deliberately defensive. It preserves the raw text of every value it does not change, so a preset round-trips byte-for-byte regardless of which tool wrote it, and fields we do not understand survive edits to fields we do.

### Adding your own presets

```
presets/user/fixtures/     # presets to test Bender against
presets/user/templates/    # starter tones offered to beginners
```

Both are gitignored — your presets stay on your machine unless you deliberately commit them. See the READMEs in each directory.

`presets/user/templates/` is **empty on purpose.** A starter tone is only useful if it actually sounds good, and that is not something we can establish from a schema. Generating plausible-looking JSON would produce a preset nobody has ever heard through an amp. The infrastructure is built; the content needs a real player.

---

## Safe editing

Preset corruption is the failure mode that matters, so the safety lives in code rather than in the prompt.

The model gets nine operations: four inspection tools, `set_parameter`, `adjust_parameter`, `enable_block`, `disable_block`, and `undo_last_change`. There is deliberately **no whole-document write, no block add/remove, and no routing change** — adding a block means choosing a position, a DSP assignment, a model identifier and a full default parameter set, and getting any of them wrong produces a file that will not load on hardware.

Every edit is transactional: clone, mutate, validate, then keep or discard. Parameter types and ranges are checked against the preset's own controller definitions, which are the only in-file source of real ranges. Unknown values are preserved untouched. Undo restores a serialized snapshot rather than applying an inverse operation, so it stays correct even for edits with side effects.

Asked to do something outside that envelope, Bender says so. Told to swap a Brit 2204 for a Dual Rectifier, it declines and points you at HX Edit rather than approximating one with tone controls.

---

## The evaluation harness

The next stage of this project is real presets, in volume. [`evals/`](evals/README.md) makes that loop fast:

```bash
pnpm eval --list
pnpm eval tapping-sustain     # one case, live model
pnpm eval --mock              # deterministic cases only, CI-safe
```

A case pairs a preset with a request and the invariants that must hold afterwards. Runs capture the fixture hash, the full model/tool transcript, every before/after value and the round-trip verdict, so two runs can be diffed when something regresses.

Cases assert what must **not** change more than what must. Almost any edit produces a tone change; the question that matters is whether Bender respected the constraint. "More sustain without more noise" is only answered correctly if the gain really did not move.

---

## Copilot agent system

This repository carries a set of reusable GitHub Copilot CLI agents ported from an internal Claude agent collection — 24 agents covering frontend, backend, testing, security, infrastructure and review work.

```bash
copilot --agent typescript-pro "tighten the types in packages/helix"
```

See [`docs/copilot-agents.md`](docs/copilot-agents.md) for the full list, how to invoke them, how to add one, and what did not map cleanly from the Claude setup.

---

## Deployment

The frontend deploys to GitHub Pages on every push to `main`, serving https://soricut.studio/ — a name inherited from this repository's previous life, and one of the open questions below.

**The backend is not deployed yet**, but it is packaged and ready to be. It cannot move into the browser, because the Azure credential must never enter a public bundle (the production build is verified free of it). Where it should run is still an open decision — see [#72](https://github.com/woohyun7878/sori-cut/issues/72).

### Building the backend artifact

```bash
pnpm --filter @bender/server build
```

This produces `apps/server/dist/`:

| File | Purpose |
| --- | --- |
| `server.mjs` | The whole server and both `@bender/*` packages in one 96 KB ESM file |
| `server.mjs.map` | Source map, for readable stack traces |
| `package.json` | Generated. Lists only the four published runtime dependencies |

`tsc` cannot produce this. The workspace packages export raw TypeScript, so compiled output resolves `@bender/helix` to a `.ts` file that Node refuses to load. Bundling removes the workspace from the deployment picture entirely.

The generated `package.json` exists because the server's own manifest declares those packages as `workspace:*` — a pnpm-only protocol that npm rejects with `EUNSUPPORTEDPROTOCOL`. The generated one is derived from the same dependency list that decides what stays external, so it cannot drift from what the bundle imports.

### Container

```bash
# from the repository root — the build stage needs the workspace
docker build -f apps/server/Dockerfile -t bender-api .

docker run --rm -p 8787:8787 \
  -e AZURE_OPENAI_ENDPOINT=https://michaeljo-playground.openai.azure.com \
  -e AZURE_OPENAI_DEPLOYMENT=gpt-5.6-sol \
  -e ALLOWED_ORIGINS=https://soricut.studio \
  bender-api
```

Two things worth knowing before you deploy this anywhere:

- **`HOST` must be `0.0.0.0` in a container.** It defaults to `127.0.0.1`, which is the right default for local development and means a containerised server is unreachable no matter what you publish. The Dockerfile sets it; a non-Docker host needs to.
- **Sessions are in memory, so run exactly one instance.** Two replicas drop sessions on roughly half of all requests. Scale out only after sessions move to shared storage.

For Azure Container Apps, give the app a managed identity with **Cognitive Services OpenAI User** and set no key at all — `DefaultAzureCredential` finds it. Key auth is disabled on the R&D resource (`403 AuthenticationTypeDisabled`), so Entra is the default rather than a fallback.

The image was not built during development because no Docker daemon was available. The runtime stage was instead reproduced by hand — generated manifest, `npm install --omit=dev`, `node dist/server.mjs` — and the server started and served `/api/health` with no workspace, no pnpm and no dev dependencies present.

---

## Limitations

- Compatibility is verified against a small fixture set, not a broad corpus.
- Sessions are held in memory, so the server is single-instance.
- Bender cannot add, remove, reorder or replace blocks, or change routing.
- No audio. Bender reasons about the signal chain, not about sound.
- Model names come from identifier splitting, so `Cab4x121960T75` renders as "Cab4x121960 T75" rather than "4x12 1960 Trem 75". A real catalogue is a known gap.
- `@type` category codes are treated as a hypothesis — two public sources contradict each other, and we never depend on them for correctness.

Open design questions are tracked as [GitHub issues](https://github.com/woohyun7878/sori-cut/issues?q=is%3Aissue+label%3Adesign-decision).

---

## Licence

MIT.
