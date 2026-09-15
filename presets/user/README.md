# Your own Helix presets

Drop `.hlx` files you personally own into the directories below. Bender reads
them from here for local testing and evaluation.

**Your presets stay on your machine by default.** `.gitignore` excludes every
`.hlx`, `.hls`, `.hlb` and `.hxb` file under `presets/user/`, with two
deliberate exceptions: `templates/` and `corpus/` are committed, because starter
tones are part of the shipped product and the corpus is shared compatibility
evidence. Anything you drop into `fixtures/` stays private.

## Directories

| | Committed | Purpose |
|---|---|---|
| `templates/` | yes | The six starter tones the app offers |
| `corpus/` | yes | The rest of the owned collection: compatibility testing and evaluation |
| `fixtures/` | no | Your private scratch space |

### `templates/`

Starter presets offered to users who arrive without a preset of their own — the
"I don't know anything about amps, make this a good modern rock lead" case.

**Six presets, one per category**, kept deliberately short: this list exists for
someone who does not know what they want, and a catalogue is the problem it
solves. See [`templates/README.md`](templates/README.md).

A template is an `.hlx` file plus a sibling `.json` metadata file of the same
name describing what it is for. **Templates are committed**, so only add presets
we own and are willing to publish.

### `corpus/`

The other 31 owned presets. Committed, but never shown to users — they exist so
the parser is tested against real hardware output on every commit, and so eval
cases have real signal chains to point at. See
[`corpus/README.md`](corpus/README.md).

Promote a preset to a starter tone by moving its two files into `templates/`.

### `fixtures/`

Presets used to exercise the parser and the evaluation harness. This is where
the real-world corpus goes.

Point an eval case at a fixture by filename; see [`../../evals/README.md`](../../evals/README.md).

## Adding presets

1. Export from HX Edit, or copy from your device.
2. Drop the `.hlx` file into `fixtures/` (or `templates/` with metadata).
3. Run the parser across everything to see what Bender does not yet understand:

   ```bash
   pnpm helix:scan presets/user/fixtures
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
