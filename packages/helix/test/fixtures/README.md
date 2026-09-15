# Test fixtures

Presets used by the `@bender/helix` test suite. Every file here is
redistributable under a permissive licence; provenance and licence are
recorded below.

Most community Helix preset repositories carry **no licence file at all**,
which means no rights are granted to redistribute them. Those repositories were
useful for *reading* format facts, but nothing from them is vendored here. If
you add a fixture, add its provenance to this file first.

For presets you personally own, use `presets/user/fixtures/` instead — that
directory is deliberately outside the test corpus and is not redistributed.

## Real-world fixtures

| File | Source | Licence | Why it is here |
|---|---|---|---|
| `hacklabs-template.hlx` | [HackLabsGuitar/helix-py-api](https://github.com/HackLabsGuitar/helix-py-api) `helixapi/templates/preset.hlx` | BSD 3-Clause, © 2024 Hack Labs Guitar | An empty "New Preset" written by HX Edit. Style A formatting (1-space indent, `" : "` separator). Covers the default/empty-chain case. |
| `hacklabs-setlist.hls` | [HackLabsGuitar/helix-py-api](https://github.com/HackLabsGuitar/helix-py-api) `helixapi/templates/setlist.hls` | BSD 3-Clause, © 2024 Hack Labs Guitar | A setlist container. Used to confirm Bender rejects non-preset files cleanly rather than half-parsing them. |
| `possum.hlx` | [sheax0r/helixgen-core](https://github.com/sheax0r/helixgen-core) `tests/fixtures/presets/possum.hlx` | MIT, © 2026 Mike Shea | A populated Helix Floor preset with an amp+cab, a drive, a volume pedal, a controller assignment, snapshots and dual-DSP routing. Style C formatting (minified). |

The two `.hlx` fixtures were chosen because they were written by **different
writers with different formatting conventions**. Round-trip tests that only
ever see one style prove very little, since the risky part of serialization is
exactly the part that varies between writers.

## Synthetic fixtures

Tests also build presets inline from string literals when they need a specific
edge case — a `1.19209e-007` exponent, an unescaped `\/`, an `irUuidTable` with
integer-like keys. Those live in the test files rather than here, because their
value is in being readable next to the assertion that uses them.

## Adding a fixture

1. Confirm the source grants redistribution rights. No licence means no.
2. Copy the file **byte for byte**. Do not reformat it, do not run it through a
   JSON prettifier, and do not let an editor change its line endings.
   `.gitattributes` marks `*.hlx`, `*.hls` and `*.hlb` as binary for this
   reason.
3. Add a row to the table above with source, licence and what it covers.
4. Prefer fixtures that add a *new* dimension — an unseen device, firmware era,
   writer style, or block category. A fourth Style A Helix Floor preset teaches
   the test suite nothing.
