# Owned preset corpus

The rest of Michael's HX Stomp collection: 31 presets we own, committed so the
whole team can test and evaluate against real hardware output.

These are **not** offered to users. The starter tones a beginner picks from live
in [`../templates/`](../templates/README.md) and are deliberately limited to six.
Everything here exists to make Bender correct, not to be chosen from.

## What it is for

1. **Compatibility evidence.** Every preset here runs through the parser on
   every commit (`packages/helix/test/library.test.ts`). A parser change that
   breaks any of them breaks the build.
2. **Evaluation and tuning.** Real presets with real signal chains to point eval
   cases at, and the raw material for improving tool descriptions, model context
   and prompts against tones someone actually played.

Measured with `pnpm helix:scan presets/user/corpus`:

| | |
|---|---|
| Presets | 31 (plus 6 in `templates/` = 37 owned) |
| Parse clean | 37 / 37, no warnings |
| Byte-exact round-trip | 37 / 37 |
| Devices | 1 (HX Stomp, `2162694`) |
| Firmware | 1 (3.80) |

Thirty-seven presets on **one device and one firmware** is evidence about that
device, not about Helix generally. Floor, Rack, LT, HX Effects and Pod Go are
all still unproven. See issue #75, decision 4.

## Ground rules

- **Byte for byte.** Files are copied straight from the device export and never
  passed through Bender's serializer. That is the entire point: a round-trip
  test here checks the parser against genuine hardware output rather than
  against Bender's own idea of what a preset looks like. Never "fix up" a file
  in this directory.
- **Only presets we own.** Same rule as everywhere else in this repository. No
  commercial or third-party preset packs.
- Each `.hlx` has a sibling `.json` using the same schema as the templates, so
  anything here can be promoted to a starter tone by moving both files.

## Presets worth knowing about

| Preset | Why it is interesting |
|---|---|
| `ichika-nito`, `ooo-rhythm` | **Ampless** — preamp and compressors only, every drive bypassed. Good stress test: there is no amp for the model to reach for. |
| `bk-lonely-boy`, `burn-house` | **Dual amp**, for multi-amp routing. |
| `sakura-long-tap` | Second tapping preset, alongside the one in `templates/`. |
| `secret` | Wah in the chain, plus a bypassed drive. |
| `eb-metal`, `eb-thrash` | Written for Eb tuning. |
| `clean`, `plush` | Shortest chains at 4 blocks. |

## Adding to the corpus

Drop in an `.hlx` you own plus a `.json` sibling, then check it parses:

```bash
pnpm helix:scan presets/user/corpus
```

Anything that warns or fails is a bug worth filing, and usually a one-line
regression test. That loop is the point of this directory.
