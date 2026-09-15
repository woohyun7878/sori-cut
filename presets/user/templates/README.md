# Starter templates

Presets offered to users who arrive without one. This covers the second MVP
user type: someone who knows what they want to *sound* like but not which
knobs produce it.

## What is in here

37 presets from Michael's HX Stomp, covering Clean, Crunch, High Gain, Lead,
Ambient Lead and one Bass tone. They are real presets that were played, not
arrangements of blocks Bender assembled from first principles — which is the
only way a starter tone is worth offering. All 37 are owned by us and safe to
publish; no commercial or third-party preset packs are included.

Every file is copied **byte for byte** from the device export. Nothing in this
directory has been through Bender's serializer. That is deliberate: it keeps
the library usable as a compatibility corpus, because a round-trip test against
these files is testing the parser against genuine device output rather than
against Bender's own idea of what a preset looks like.

Current state, from `pnpm helix:scan presets/user/templates`:

| | |
|---|---|
| Presets | 37 |
| Parse clean | 37 / 37, no warnings |
| Byte-exact round-trip | 37 / 37 |
| Devices | 1 (HX Stomp, `2162694`) |
| Firmware | 1 (3.80) |

Thirty-seven presets on **one device and one firmware** is evidence about that
device, not about Helix generally. Floor, Rack, LT, HX Effects and Pod Go are
all still unproven. See issue #75, decision 4.

Drop in more presets you own and they appear as starting points automatically.

## Adding a template

Two files with the same base name:

```
presets/user/templates/
  modern-rock-lead.hlx     the preset itself
  modern-rock-lead.json    metadata describing it
```

### Metadata schema

```json
{
  "id": "modern-rock-lead",
  "name": "Modern Rock Lead",
  "category": "Lead",
  "summary": "Mid-forward high-gain lead with moderate compression and a short slap delay.",
  "bestFor": ["solos", "melodic lines", "tapping"],
  "device": 2162694,
  "owner": "Michael Johnson",
  "notes": "Built from the Brit 2204. Gate is set conservatively; tighten it for higher-output pickups."
}
```

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Stable identifier. Must match the filename. |
| `name` | yes | Shown in the UI. |
| `category` | yes | One of `Clean`, `Crunch`, `Modern Rhythm`, `High Gain`, `Lead`, `Ambient Lead`, or your own. |
| `summary` | yes | One sentence. Also given to the model as context for what the preset is meant to do. |
| `bestFor` | no | Short phrases used to match a template to a user's stated intent. |
| `device` | no | Device id the preset targets. Bender warns when it does not match the user's other presets. Read it from the file rather than guessing. |
| `owner` | no | Who owns it. Worth recording before this list grows. |
| `notes` | no | Anything a human should know. Not sent to the model. |

`category` and `bestFor` are what let the model pick sensibly when a user says
"I want a modern rock lead" — the model reads the summaries and chooses, rather
than matching against a hardcoded keyword table.

## Categories

The categories above are a starting vocabulary, not a schema constraint. Add
your own; the UI groups by whatever values it finds.
