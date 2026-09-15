# Bender — design review · Tue 15 Sep 2026 · 2 hours

**Bender: your AI guitar tone engineer.** Upload a Helix `.hlx`, describe a tone problem in
plain English, a model reasons over the real signal chain and invokes constrained tools that
edit the preset. Diff it, undo it, download it.

**Today is decisions only — no laptops open.** The output of this session is a build plan with
owners for **Wed 16 → Sun 20**. Build time after today: 3 weekdays plus the weekend.

---

## Where we actually are

On `main`, CI green, 322 tests, frontend live at **soricut.studio**.

Verified end-to-end against live Azure: *"My tapped notes are too transient and die too
quickly…"* → 5 tool calls → `Master 0.36→0.46`, `BiasX 0.5→0.58` → undo ×2 → **byte-identical
SHA-256**. The model never writes JSON; it calls typed tools, and untouched values are
re-emitted as original source text, so fields Bender doesn't understand survive byte-exact.

**Two uncomfortable truths, and every decision below follows from them:**

1. **The backend runs nowhere.** The public site honestly tells visitors it has no backend.
2. **Compatibility rests on 2 fixtures, 1 device, 1 firmware.** We cannot currently claim
   Bender reads "Helix presets" — only that it reads these two.

---

## Agenda

**0:00–0:15 · Demo the working thing.** Grounds the argument in what exists rather than in what
we remember writing.

**0:15–1:30 · Decisions.** Each has a recommendation. If nobody objects inside the timebox, the
recommendation stands and we move on. *Blocking decisions first — if we run out of time, we run
out of it on the ones that matter least.*

| # | Decision | Issue | Box |
|---|---|---|---|
| 1 | Backend host **and** auth | #72 #69 | 15 |
| 2 | Preset corpus — whose, and shippable? | #67 #68 | 15 |
| 3 | Demo story + what's cut | #73 #66 | 15 |
| 4 | What compatibility do we *claim*? | #67 | 10 |
| 5 | How failures become tests | #70 | 10 |
| 6 | Chat-first vs chain-first | #71 | 10 |
| 7 | Repo rename / domain | #65 | 5 |
| 8 | The dropped SoriCut export work | #74 | 5 |

**1:30–1:50 · Build plan and owners for Wed→Sun.**
**1:50–2:00 · Risks, and what would make us cut scope.**

---

## The decisions, with recommendations

**1 · Backend host and auth (#72, #69).** One decision, not two — the auth mechanism depends on
the host. *The trap:* the R&D key we were issued is dead (`403 AuthenticationTypeDisabled`);
everything currently runs on Entra ID, which is fine locally and awkward in a container.
**Recommend** Azure Container Apps with a **managed identity** — no secret to leak, and it is
the code path we already test. *Constraint the room must know: sessions are in-memory, so single
instance, no autoscale.* **Not deciding today costs us Wednesday.**

**2 · Preset corpus (#67, #68).** The highest-leverage 15 minutes of the session. **Your own
`.hlx` files are worth more this week than anything any of us will code.** Two distinct
questions: presets we *test* against (private, gitignored, no licensing issue) and presets we
*ship* as starter tones (someone must own having authored them). **Recommend** everyone brings
15–20 of their own by Wednesday morning, and we ship none. *This decision has a deadline
attached — if it doesn't land today, Wednesday's intake track has no input.*

**3 · Demo story and scope (#73, #66).** **Recommend** demoing the tapping/sustain story
unchanged: it works, it is legible to non-guitarists, and the byte-identical undo is the moment
that proves this isn't a chatbot guessing at JSON. **Cut:** audio analysis, reference-track
matching, hardware, starter library. **Keep:** upload → chain → request → diff → undo →
download.

**4 · Compatibility claims (#67).** What goes on the slide? **Recommend** we say exactly what
the scan tells us — *"N of M real presets round-trip byte-exact"* — and nothing softer or
grander. We will know the number Wednesday. Overclaiming here is the cheapest way to lose the
room in Q&A.

**5 · Failures into tests (#70).** The loop the rest of the week lives in: drop preset →
`pnpm helix:scan` → triage → write eval case → fix → `pnpm eval --mock` in CI. **Decide:** do we
keep model transcripts in the repo? **Recommend** yes — diffing two runs is how we will tell a
real regression from ordinary model variance.

**6 · Chat-first vs chain-first (#71).** Currently both, side by side. **Recommend** leaving it
alone and spending the time on presets instead. Reopen only if the Sunday rehearsal says
otherwise.

**7 · Rename (#65).** **Recommend** no rename this week. The *domain* is the branding question,
not the repo name — `soricut.studio` is a verified custom domain, so renaming the repo changes
nothing a visitor sees. Decide the domain separately, later.

**8 · Dropped export work (#74).** The pivot dropped 962 lines of recent SoriCut
export-hardening. Fully recoverable from `689466c`. Needs a yes/no, not an assumption.

---

## Build plan — Wed 16 → Sun 20 *(assign owners today)*

**Critical path is Track A → demo.** Track B decides whether the demo is *impressive* or merely
*works*; it runs fully in parallel and needs no backend.

| | Track A — make it public | Track B — make it good |
|---|---|---|
| **Wed** | Deploy backend; set `BENDER_API_URL`; verify Pages end to end | All presets in; `pnpm helix:scan`; triage failures |
| **Thu** | Harden: CORS, timeouts, cold start, error states | Fix the parser gaps the scan found; first eval cases |
| **Fri** | Second device/firmware if the corpus demands it | Broaden tone requests; find where the model reasons badly |
| **Sat** | **Feature freeze.** Bug fixes only | Regression pass: `pnpm eval --mock` green |
| **Sun** | Rehearse twice, end to end, on the deployed stack | Slide with the real compatibility number |

**Freeze Saturday.** A demo that breaks live is worse than one that does less. Anything not
working by Friday night gets cut rather than rushed.

---

## Risks to name out loud

Single-instance in-memory sessions — a restart drops everyone's work mid-demo · live model
latency around 14 s, so the UI must look busy and honest · compatibility could crater the moment
real presets land, **which is exactly why we scan Wednesday and not Sunday** · the dead R&D key
makes auth a live dependency rather than a formality.

*Backlog: #65–#74. Format evidence and its limits: `docs/helix-format-notes.md` — separates
observed fact from hypothesis from unknown. Architecture: `docs/architecture.md`.*
