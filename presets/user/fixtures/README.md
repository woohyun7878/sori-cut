# Preset fixtures

Real `.hlx` files used to exercise the parser and the evaluation harness.

Empty by design: this is where your own corpus goes. Nothing here is committed.

Drop files in and scan them:

```bash
pnpm helix:scan presets/user/fixtures
```

The scan reports, per file: whether it parses, whether it round-trips byte for
byte, what device and firmware it targets, and any validation warnings. Files
that fail are the highest-value input Bender can get — each one is a gap in the
parser and usually a one-line regression test.

See [`../../../evals/README.md`](../../../evals/README.md) for turning a
failure into a permanent test case.
