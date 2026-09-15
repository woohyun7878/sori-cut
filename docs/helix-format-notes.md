# Helix `.hlx` format notes

Line 6 publishes no schema for `.hlx`. Everything here was established by reading real presets and by cross-checking independent open-source implementations.

**This document is organized by confidence.** Do not promote a claim to a higher section without new evidence. Code that depends on a Hypothesis must degrade gracefully when the hypothesis is wrong.

- [Observed](#observed) — verified against real files
- [Implementation choices](#implementation-choices) — how Bender behaves, and why
- [Hypotheses](#hypotheses) — plausible, single-source, or partially contradicted
- [Unknown](#unknown) — open questions needing more fixtures
- [Sources](#sources)

---

## Observed

Evidence base: ~250 real `.hlx` files sampled from public repositories, spanning firmware 2.21 → 3.80 and every device in the Helix family (Floor, Rack, LT, HX Effects, HX Stomp, HX Stomp XL, Helix Native, POD Go).

### Container

`.hlx` is **plain, uncompressed, human-readable UTF-8 JSON**. No magic header, no binary preamble, no compression. Files begin directly with `{`.

### Top-level envelope

```jsonc
{
  "data":    { "device": 2162694, "device_version": 50397184, "meta": { … }, "tone": { … } },
  "meta":    { "original": 0, "pbn": 0, "premium": 0 },   // OPTIONAL — absent in some real files
  "schema":  "L6Preset",                                   // always this literal
  "version": 6                                             // always 6, fw 2.21 → 3.80
}
```

- `schema` is `"L6Preset"` in 110/110 sampled files. It is the correct format sniff.
- `version` is `6` in 110/110 files. The container schema has been stable across the entire modern firmware era.
- Top-level `meta` is **optional** (109/110).
- **Top-level key order is not stable** between files — some emit `data, meta, schema, version`, others `data, version, schema`.
- There is **no `presetKey` key.** It does not appear in any sampled file.

### `data.meta`

Free-form and extensible. Observed keys include `name`, `application`, `appversion`, `build_sha`, `modifieddate`, and — on CustomTone-sourced presets — `tnid`, `song`, `band`, `author`.

Whatever is not modelled must be kept.

### `data.tone`

Key frequency across 110 files:

| Key | Count | Notes |
|---|---|---|
| `dsp0`, `dsp1` | 110 | `dsp1` may be `{}` |
| `global` | 110 | |
| `snapshot0`–`snapshot2` | 110 | |
| `snapshot3`–`snapshot7` | 51–52 | 8 snapshots on Helix/Native, 3 on HX Stomp |
| `variax` | 98 | |
| `controller` | 95 | controller *assignments* |
| `footswitch` | 80 | |
| `powercab0/1/dual`, `dt0/1/dual` | 42 | |
| `irUuidTable` | 29 | numeric-string keys `"000"`…`"127"` |
| `commandFS1/2/6`, `commandInst1` | 1–3 | undocumented |

### `data.tone.dspN` slots

A DSP object mixes effect slots with structural slots:

| Slot key | Count (130 files) | Meaning |
|---|---|---|
| `block0`…`blockN` | 882 | effect/amp blocks |
| `cab0`, `cab1` | 56 | cabs referenced by an amp block |
| `inputA` / `inputB` | 181 each | path inputs |
| `outputA` / `outputB` | 181 each | path outputs |
| `split` / `join` | 181 each | routing nodes |

### Block shape

`@`-prefixed keys are structural/attribute; **everything else is a parameter**, stored as a flat sibling.

```jsonc
"block0": {
  "@bypassvolume": 1.0,
  "@cab": "cab0",              // sibling reference to a cabN key in the SAME dspN
  "@enabled": true,            // bypass state
  "@model": "HD2_AmpEssexA30",
  "@no_snapshot_bypass": false,
  "@path": 0,
  "@position": 0,
  "@type": 3,
  "Bass": 0.40, "Drive": 0.550, "Master": 1.0, "Treble": 0.560   // parameters
}
```

### Parameter values are NOT normalized 0–1

This is a common and damaging misconception. Real values observed:

| Value | Unit |
|---|---|
| `"HighCut": 4263.0`, `"LowCut": 96.0` | Hz |
| `"threshold": -48.0`, `"Level": -18.0` | dB |
| `"@tempo": 120.0` | BPM |
| `"Time": 8.0` | seconds |
| `"@mic": 13`, `"Index": 17` | enum |
| `"TempoSync1": false` | boolean |

Values mix floats, integers, and booleans, and several are in display units. A parameter type must be a tagged union, not `number`.

### `@model` prefixes vary — do not assume `HD2_`

Observed prefixes: `HD2_`, `HelixStomp_`, `HelixFx_`, `VIC_`, `Victoria_`, `L6SPB_`, `P34_` (POD Go), and bare (`ShufflingLooper`). A handful of models appear under display names rather than symbolic IDs.

### Routing: `(@path, @position)`

- `@path`: `0` = upper branch A, `1` = lower branch B.
- `@position`: slot index **within that branch**, not a global index.
- Verified: `(@path, @position)` is unique within a DSP — 882/882 pairs, zero clashes.
- **The block's key and its `@position` are independent.** `block5` may carry `@position: 6`. Neither can be derived from the other.

Reordering must **exchange** `@position` values between two blocks on the same branch, never renumber.

### `global.@topologyN` encodes split/join routing

Observed values: `@topology0` ∈ {`"A"`, `"SABJ"`, `"SAB"`, `"AB"`}; `@topology1` ∈ {`"A"`, `"SABJ"`, `"ABJ"`, and the **number `0`**}.

Letters: `S` = split opens, `A` = path A, `B` = path B, `J` = join closes.

**Type hazard:** `@topology1` is the number `0` in 41/70 sampled files. It is `string | number`, not a string union. At least one public TypeScript implementation types this incorrectly.

### Snapshots

`tone.snapshot0` … `tone.snapshot7` — fixed keys, **not an array**.

```jsonc
"snapshot0": {
  "@ledcolor": 0, "@name": "SNAPSHOT 1", "@pedalstate": 0,
  "@tempo": 120.0, "@valid": true,
  "blocks":      { "dsp0": { "block0": true, "block3": false } },
  "controllers": { "dsp0": { "block3": { "Feedback": { "@fs_enabled": false, "@value": 1.0 } } } }
}
```

### Snapshot data is stored TWICE and must not drift

This is the single most dangerous editing hazard in the format.

- `tone.global.@current_snapshot` names the active snapshot.
- `tone.snapshotN.blocks[dsp][slot]` holds per-snapshot bypass state.
- `tone.snapshotN.controllers[dsp][slot][param]["@value"]` holds per-snapshot parameter values.
- **The block's own `@enabled` and parameter values mirror the active snapshot.** Verified across 24 presets: 203 bypass entries + 53 controller params, zero mismatches.

Any edit to bypass, or to a snapshot-controlled parameter, must write **both** locations. Writing only the block is silently reverted by the hardware on the next snapshot recall.

Snapshot `@tempo` does **not** mirror `global.@tempo`.

### Controller assignments

```jsonc
"controller": { "dsp0": { "block3": { "Mix": { "@controller": 9, "@min": 0.0, "@max": 1.0 } } } }
```

Observed `@controller` IDs over 130 files: `19` (n=276) and `9` (n=263) dominate; also 1, 2, 3, 4, 7, 8, 10, 13. `19` correlates with Helix Floor/LT, `9` with HX Stomp.

**Useful side effect:** when a controller is assigned, its `@min`/`@max` reveal the parameter's true display-unit range (e.g. `HighCut` `@min: 500.0, @max: 20100.0`). This is the only in-file source of real parameter ranges.

### Three distinct byte-level writer styles

Measured over 110 files by the indentation of the depth-2 key `device`:

| Style | Share | Indent | Colon | Float rendering |
|---|---|---|---|---|
| **A** | ~89% | 1 space/level | `" : "` | `0.560`, `120.0`, `1.19209e-007` (3-digit exponent) |
| **B** | ~5% | 2 spaces/level | `" : "` | `0.40999996662139893` (17 significant digits) |
| **C** | ~5% | minified | `":"` | `0.838418`, `0.35`, `4300` (no `.0`) |

Two files with the **identical** `build_sha` appeared in both Style A and Style B, so style is not purely a firmware function — community files may have been re-saved by third-party tools.

**A serializer must derive formatting from the input file, never hardcode a style.**

### Device IDs (`data.device`)

| ID | Hex | Device |
|---|---|---|
| 2162689 | `0x210001` | Helix Floor / Rack |
| 2162692 | `0x210004` | Helix LT |
| 2162693 | `0x210005` | HX Effects |
| 2162694 | `0x210006` | HX Stomp |
| 2162699 | `0x21000B` | HX Stomp XL |
| 2162944 | `0x210100` | Helix Native |
| 2162695 / 2162696 | `0x210007/8` | POD Go |

A preset for one device will not load on another.

### `data.device_version` is packed BCD

Verified: every byte of every `device_version` in 110 sampled files had both nibbles ≤ 9. Layout `0xMM_mm_BBbb` = major . minor . 4-digit BCD build.

`0x03110000` → 3.11 · `0x02210020` → 2.21 build 0020 · `0x03800000` → 3.80

### Related formats

| Ext | `schema` | `version` | Container |
|---|---|---|---|
| `.hlx` | `L6Preset` | 6 | plain JSON |
| `.hls` | `L6Setlist` | 2 | JSON wrapper + base64 + zlib, 128 presets |
| `.hlb` | `L6PresetBundle` | 1 | JSON wrapper + base64 + zlib, 8 × 128 |
| `.hxb` | — | — | binary, `AF6L` header |

For `.hls`/`.hlb`, `compression.crc32` is standard CRC-32/IEEE (`zlib.crc32`) over the **inflated** bytes, and must be recomputed on write. Independently verified: computed `18372250` == declared `18372250`.

Setlist entries are bare `data` objects with no `schema`/`version` of their own. Empty slots are literally `{}`.

**`.hxp` does not appear to exist.** No evidence found for that extension.

---

## Implementation choices

These are decisions Bender made, not facts about the format.

### We preserve raw number lexemes

The exact float formatter for Style A could not be derived — `0.560`, `0.699999`, `1.19209e-007` is neither `%.17g` nor JavaScript's shortest-round-trip representation.

Rather than guess, Bender's parser **retains the original source text of every number token**. On serialize:

- Numbers that were never modified are re-emitted **verbatim from their original lexeme**.
- Only numbers Bender actually changed are formatted, using the style detected from the input.

This makes byte-exact round-tripping of untouched values correct *regardless* of which writer produced the file, and confines the unknown-formatter risk to the handful of values an edit actually touches. See `packages/helix/src/json/`.

### We preserve key order

`JSON.parse` in JavaScript hoists integer-like object keys, which would reorder maps such as `irUuidTable`. Bender uses an order-preserving JSON parser and emits keys in their original order.

### We preserve unknown data

Any key, slot, or section Bender does not model is retained verbatim and re-emitted. Unrecognized `@model` values, `commandFS*` sections, and future firmware additions all survive a round trip.

### We do not treat unfamiliarity as an error

An unknown block model or parameter is normal and produces at most a warning. Only structurally impossible documents are errors.

### Parameter name matching is lenient

Line 6's own spelling drifts between models and firmware eras (`HighCut` vs `High Cut`, `EarlyReflections` vs `Early Reflections`). Bender matches parameter names case-insensitively with whitespace stripped, but **always writes back the exact key that already exists in the file**.

---

## Hypotheses

Plausible but single-source, or contradicted by another source. Code must not hard-depend on these.

### `@type` category codes

From one credible source, consistent with our samples but not exhaustively verified:

`0` = FX · `1` = Amp (no cab) · `2` = Cab · `3` = Amp (with `@cab`) · `4` = dual Cab · `5` = IR · `6` = Looper · `7` = Delay & Reverb

**Conflict:** a second public implementation publishes a completely different table (`0`=dynamics, `2`=eq, `4`=cab …). Our observations contradict that second table — `HD2_EQGraphic10Band` has `@type: 0`, not `2`. We use the table above, defensively.

### Forward-slash escaping

One source reports HX Edit emits `"1\/4 DLY"` — JSON permits `\/` but neither `JSON.stringify` nor Python's `json.dumps` produces it. Reported as 2 escaped / 0 bare across their corpus; we observed 0 occurrences of either. Rare but credible; only arises with note-division labels.

Bender's lexeme-preserving serializer is immune to this for unmodified strings.

### `@stereo` absence is meaningful

One source reports `@stereo` is written only when a model has both mono and stereo variants, so an absent `@stereo` means "the variant that exists", not "mono".

### Footswitch `@fs_index`

Sources conflict. One reports `@fs_index − 1` is the array position and that one switch can hold several bindings ordered with `@fs_primary` first. Another reports `@fs_index` ranges 2..18, cannot be a switch number, and the mapping is undecoded.

Bender treats the whole `footswitch` section as opaque and preserves it.

---

## Unknown

Open questions. More fixtures would settle these.

- **The exact float formatter for Style A.** The biggest open risk to byte-exact round-tripping, mitigated but not eliminated by lexeme preservation. Resolve empirically against known-good HX Edit exports.
- `commandFS1/2/6` and `commandInst1` structure — present in 1–3 of 110 files, documented nowhere.
- `@fs_ledcolor` colour encoding (values like `196619`, `525824`, `65408`) and `@fs_customcolor` palette indices.
- Controller IDs other than `9` and `19` (1, 2, 3, 4, 7, 8, 10, 13) — presumed EXP pedals / MIDI CC / Variax knobs.
- Semantics of `data.meta.original`, `pbn`, `premium`, `tnid`.
- Whether `device_version` ever appears as a string. One source claims it can; we measured Int64 in 130/130 and could not reproduce.
- Complete parameter range/type metadata. The official catalog lives in HX Edit's proprietary resources. The only in-file range evidence is `controller[…].@min/@max`.

### What more fixtures would buy us

| Fixture type | Settles |
|---|---|
| Presets exported by a known HX Edit version | The Style A float formatter |
| Presets using `commandFS*` | Command Center structure |
| Presets with many controller assignments | Real parameter ranges |
| Multi-device presets | Device-specific slot availability |
| Presets with dual-cab and IR blocks | `@type` 4 and 5 confirmation |

Drop owned presets into `presets/user/fixtures/` — see `presets/user/README.md`.

---

## Sources

Public open-source implementations consulted. All were read for **facts only**; no code was copied.

| Project | Licence | Value |
|---|---|---|
| `ariefs-dev/hx-tools` | MIT | TypeScript `.hlx` codec; dense format notes |
| `john-baxter-dev/fretwire` | Apache-2.0 | Hardware-verified preset/device mapping |
| `retr0h/tonestack` | MIT | Cleanest prose spec; device ID table; corpus licensing audit |
| `HackLabsGuitar/helix-py-api` | BSD-3-Clause | Clean `.hlx` / `.hls` / `.hlb` templates |
| `sheax0r/helixgen-core` | MIT | A real `.hlx` test fixture |
| `AntonyCorbett/HelixBackupFiles` | none | `.hxb` binary layout description |

### Licensing note

Many community preset repositories carry **no licence file**, which means no grant of rights. They are fine to read for format facts; they are **not** safe to vendor as fixtures.

Line 6's official CustomTone library sits behind a login requiring a registered product serial and is not fetchable.

Model identifiers such as `HD2_AmpBrit2204` are Line 6 identifiers. Official display names, artwork, and parameter catalogs live in HX Edit's proprietary resources. Bender ships neutral placeholders and never bundles proprietary catalog data.
