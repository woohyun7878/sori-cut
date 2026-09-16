# Bender

> Your AI guitar tone engineer.

Bender reads a Line 6 Helix preset, shows you its signal chain, and turns a plain-English request into safe, reviewable edits. Every change is shown, undoable, and downloadable as a working `.hlx`.

Ask:

```
My tapped notes are too transient and die too quickly.
Give them more body and sustain without making the preset noisy.
```

A real run raised `Sag` 0.5→0.58, `Master` 0.36→0.48 and `BiasX` 0.5→0.6 — power-amp
bloom rather than more gain, with the preamp gain left alone as asked.

---

## Status

A working prototype.

**Works:** `.hlx` parse and round-trip, a typed signal-chain model, nine constrained editing tools with validation and undo, multi-turn tool-calling against Azure OpenAI, an eval harness, and upload → chat → diff → undo → download end to end.

**Not claimed:** broad Helix compatibility. Verified against a small fixture set only. See [`docs/helix-format-notes.md`](docs/helix-format-notes.md) for what is established versus guessed.

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

The model never writes Helix JSON. It gets nine deterministic operations, nothing else.

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
cp apps/server/.env.example apps/server/.env   # read automatically at startup
az login
```

Two resources, on purpose:

| | Local development | Production |
|---|---|---|
| Resource | your own dev/playground resource | a separate Azure AI Foundry resource |
| Auth | Entra ID (`az login`) | API key, held in App Service settings |
| Cost | dev quota | real budget |

**Develop against your own resource, never production** — local turns cost the
budget the live app runs on.

`apps/server/.env.local` overrides `.env`, so pointing at a different deployment
is one file, and deleting it switches back. Both are gitignored, and real
environment variables beat both — a deployed host ignores them. The startup log
names the files it read and the deployment it is talking to:

```json
{"event":"server.starting","model":"https://<resource> deployment=<name> api-version=2025-04-01-preview auth=entra","envFiles":[".env"]}
```

`AZURE_OPENAI_ENDPOINT` takes either the resource origin or the full Responses
URL the portal shows; the path and `api-version` are parsed out of the latter.

Two failure modes worth knowing:

- `403 AuthenticationTypeDisabled` — key auth is off on the dev resource. Use Entra ID (the default). Key auth works when a resource allows it; set `AZURE_OPENAI_API_KEY` and it is used.
- `404 DeploymentNotFound` — `AZURE_OPENAI_DEPLOYMENT` takes a **deployment** name, not a model name.

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
pnpm test          # 482 tests
pnpm build
pnpm eval --mock   # deterministic evaluation cases, no network
pnpm eval          # full suite against the live model
```

---

## Helix presets

A `.hlx` file is plain UTF-8 JSON with sharp edges. Read [`docs/helix-format-notes.md`](docs/helix-format-notes.md) before touching the parser. Three that cause real bugs:

- **Values are not normalized.** `HighCut` is in Hz (`20100`), `threshold` in dB (`-48.0`), `@tempo` in BPM. Writing `0.5` into a `HighCut` sets a 0.5 Hz filter.
- **Snapshot data is stored twice**, in `snapshotN.blocks` and `snapshotN.controllers`. Write one without the other and the preset is quietly inconsistent — worse than one that fails to load.
- **A block's key is independent of its position.** Routing is `@path` plus `@position` *within that branch*; `block0` can sit third in the chain.

The parser preserves the raw text of every value it does not change, so presets round-trip byte for byte and unknown fields survive edits.

### Preset directories

```
presets/user/templates/    # the 6 starter tones offered to beginners  (committed)
presets/user/corpus/       # 31 more owned presets, for testing/eval    (committed)
presets/user/fixtures/     # your own scratch presets                   (private)
```

37 real HX Stomp presets, owned by us, copied byte for byte from the device
export. Six are offered as starting points, one per category. The other 31 run
through the parser on every commit, so a change that breaks genuine hardware
output breaks the build. Anything in `fixtures/` stays on your machine.

**Compatibility:** 37 / 37 parse clean and round-trip byte for byte — on **one
device (HX Stomp), one firmware (3.80)**. No evidence about Floor, Rack, LT, HX
Effects or Pod Go.

---

## Safe editing

Preset corruption is the failure mode that matters, so the safety lives in code rather than in the prompt.

The model gets nine operations: four inspection tools, `set_parameter`, `adjust_parameter`, `enable_block`, `disable_block`, `undo_last_change`. There is deliberately **no whole-document write, no block add/remove, and no routing change** — adding a block means choosing a position, DSP assignment, model identifier and full default parameter set, and getting any of them wrong produces a file that will not load on hardware.

Every edit is transactional: clone, mutate, validate, then keep or discard. Ranges are checked against the preset's own controller definitions, the only in-file source of real ranges. Undo restores a serialized snapshot rather than an inverse operation, so it stays correct for edits with side effects.

Asked to swap a Brit 2204 for a Dual Rectifier, Bender declines and points you at HX Edit rather than approximating one with tone controls.

---

## The evaluation harness

[`evals/`](evals/README.md) replays real presets against real requests:

```bash
pnpm eval --list
pnpm eval tapping-sustain     # one case, live model
pnpm eval --mock              # deterministic cases only, CI-safe
```

A case pairs a preset with a request and the invariants that must hold afterwards. Runs capture the fixture hash, the full model/tool transcript, every before/after value and the round-trip verdict, so two runs can be diffed.

Cases assert what must **not** change more than what must. Almost any edit changes the tone; the question is whether the constraint held. "More sustain without more noise" is only correct if the gain did not move.

Every run prints what it cost — tokens in and out, model turns, tool calls, and tokens per edit landed. Pass/fail alone will not tell you that a case passed by burning 18k tokens on nine tool calls.

Whether it *sounded* right is not decidable by a check, so it is recorded by hand after playing the preset:

```bash
pnpm eval feedback bad "harsh top end, gain went too far"
```

Verdicts are committed to `evals/feedback/`, keyed to the run and carrying the exact edits. Runs where the checks and your ears disagree are the ones worth reading.

---

## The model catalogue

Line 6 does not publish one, and the proprietary catalogue inside HX Edit is not ours to copy. So it is derived from presets we own:

```bash
pnpm helix:catalogue
```

Walking every preset in the corpus yields which models exist, what their parameters are called, and — where a controller assignment reveals it — what range a parameter really has. It can only ever contain things a real device produced, and coverage grows by exporting more presets rather than by trusting a list.

Ranges are reported only when a controller proved them. The values our corpus happens to contain are a floor, not a range, and treating them as one would have a tool reject a legitimate setting.

Display names are the exception: they are hand-recorded in `packages/helix/data/model-names.json` as they are confirmed against real hardware, because no amount of parsing tells you where `4x12` ends and `1960` begins.

---

## Copilot agent system

24 reusable GitHub Copilot CLI agents covering frontend, backend, testing, security, infrastructure and review work.

```bash
copilot --agent typescript-pro "tighten the types in packages/helix"
```

See [`docs/copilot-agents.md`](docs/copilot-agents.md) for the full list and how to add one.

---

## Deployment

| Piece | Where | How |
| --- | --- | --- |
| Frontend | GitHub Pages → https://soricut.studio/ | Automatic, on every push to `main` |
| Backend | Azure App Service (Linux container, West US 3) | **Manual**, by the App Service owner |

```bash
curl https://bender-backend-cvdxhaaubjdmb4c3.westus3-01.azurewebsites.net/api/health
# {"status":"ok","activeSessions":0}
```

> [!IMPORTANT]
> **The backend is deployed by hand, so `main` can be ahead of production.** A
> green `/api/health` means a Bender server is up, not that it is *this* commit.
> Server changes ship only when someone rebuilds the image and redeploys.

The frontend bakes the backend URL in at build time from the `BENDER_API_URL`
repository variable (Settings → Secrets and variables → Actions → Variables), so
moving the backend needs a Pages rebuild.

### Ownership and secrets

The App Service and the model resource are owned separately, which is why no key
is in this repository:

- **App Service** — hosts the API and holds the Azure OpenAI key in application settings. The only thing the browser talks to.
- **Azure AI Foundry resource** — serves the production deployment, with key auth. The key is a bearer credential: anyone holding it can spend the budget. If it lands in a chat, screenshot, log or commit, rotate it and update the App Service setting.

| Public | Never public |
| --- | --- |
| The Pages origin | The Azure OpenAI endpoint and deployment name |
| The backend hostname (baked into the frontend bundle) | The API key |
| `/api/health` — `status` and `activeSessions` only | Resource group and deployment credentials |

`/api/health` reports nothing about the model path on purpose. The endpoint,
deployment and auth mode are not credentials, but publishing them tells anyone
holding a leaked key where to spend it. They are logged at startup
(`server.starting`) instead, readable from the App Service log stream.

### Building the backend artifact

```bash
pnpm --filter @bender/server build
```

This produces `apps/server/dist/`:

| File | Purpose |
| --- | --- |
| `server.mjs` | The whole server and both `@bender/*` packages in one 96 KB ESM file |
| `server.mjs.map` | Source map, for readable stack traces |
| `package.json` | Generated. Lists only the four published runtime dependencies and starts the bundle with `npm start` |

`tsc` cannot produce this: the workspace packages export raw TypeScript, so compiled output resolves `@bender/helix` to a `.ts` file Node refuses to load. The generated manifest exists because the server's own declares those packages as `workspace:*`, which npm rejects with `EUNSUPPORTEDPROTOCOL`.

### Container

Production runs the image built by [`apps/server/Dockerfile`](apps/server/Dockerfile).

```bash
# from the repository root — the build stage needs the workspace
docker build -f apps/server/Dockerfile -t bender-api .

docker run --rm -p 8787:8787 \
  -e AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com \
  -e AZURE_OPENAI_DEPLOYMENT=<your-deployment> \
  -e ALLOWED_ORIGINS=https://soricut.studio \
  bender-api
```

- **`HOST` must be `0.0.0.0` in a container.** It defaults to `127.0.0.1`, which is right locally and makes a container unreachable. The Dockerfile sets it; other hosts need to.
- **Sessions are in memory, so run exactly one instance.** Two replicas drop sessions on roughly half of all requests.

### Host settings

Names only; values belong in the host's configuration store.

```text
AZURE_OPENAI_ENDPOINT      https://<resource>.cognitiveservices.azure.com
AZURE_OPENAI_DEPLOYMENT    <deployment name, not a model name>
AZURE_OPENAI_API_VERSION   2025-04-01-preview
AZURE_OPENAI_AUTH_MODE     api-key
AZURE_OPENAI_API_KEY       <from the Foundry resource — never committed>
HOST                       0.0.0.0
ALLOWED_ORIGINS            https://soricut.studio
```

`ALLOWED_ORIGINS` is the CORS allowlist, set to the Pages origin alone. It is not
authentication.

A host with managed identity can skip the key: assign an identity with
**Cognitive Services OpenAI User** on the resource, leave `AZURE_OPENAI_API_KEY`
unset, and `DefaultAzureCredential` finds it.

---

## Limitations

- Compatibility is verified against a small fixture set, not a broad corpus.
- The backend is deployed by hand, so production can lag `main`.
- Sessions are held in memory, so the server is single-instance.
- Bender cannot add, remove, reorder or replace blocks, or change routing.
- No audio. Bender reasons about the signal chain, not about sound.
- Model names come from identifier splitting unless curated in `packages/helix/data/model-names.json`, so an uncurated `Cab4x121960T75` renders as "Cab4x121960 T75" rather than "4x12 1960 Trem 75".
- `@type` category codes are treated as a hypothesis — two public sources contradict each other, and we never depend on them for correctness.

Open design questions are tracked as [GitHub issues](https://github.com/woohyun7878/sori-cut/issues?q=is%3Aissue+label%3Adesign-decision).

---

## Licence

MIT.
