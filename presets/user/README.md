# Your own Helix presets

Drop `.hlx` files you personally own into the directories below. Bender reads
them from here for local testing and evaluation.

**Nothing in this directory is committed.** `.gitignore` excludes every `.hlx`,
`.hls`, `.hlb` and `.hxb` file under `presets/user/`, so your presets stay on
your machine. Only the READMEs and `.gitkeep` files are tracked.

## Directories

### `templates/`

Starter presets offered to users who arrive without a preset of their own — the
"I don't know anything about amps, make this a good modern rock lead" case.

A template is an `.hlx` file plus a sibling `.json` metadata file of the same
name describing what it is for. See [`templates/README.md`](templates/README.md)
for the schema.

### `fixtures/`

Presets used to exercise the parser and the evaluation harness. This is where
the real-world corpus goes.

Point an eval case at a fixture by filename; see [`../../evals/README.md`](../../evals/README.md).

## Adding presets

1. Export from HX Edit, or copy from your device.
2. Drop the `.hlx` file into `fixtures/` (or `templates/` with metadata).
3. Run the parser across everything to see what Bender does not yet understand:

   ```bash
   pnpm --filter @bender/helix exec tsx scripts/scan.ts presets/user/fixtures
   ```

4. Anything that fails is a bug worth filing, and usually a one-line regression
   test. That loop is the point of this directory.

## Ownership

Only add presets you own or have the right to use. Bender ships no commercial
presets and none are fabricated to look like commercial presets. The test
corpus in `packages/helix/test/fixtures/` contains only permissively licensed
files, with provenance recorded alongside them.

Presets you place here are never uploaded anywhere. Bender sends the model a
*structured summary* of a preset — block models, parameter names and values —
not the file itself, and the summary goes only to the Azure OpenAI endpoint you
configure.
