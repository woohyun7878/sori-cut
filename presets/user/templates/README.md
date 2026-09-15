# Starter templates

Presets offered to users who arrive without one. This covers the second MVP
user type: someone who knows what they want to *sound* like but not which
knobs produce it.

## What is in here

**Six presets — one per category.** They are real presets from Michael's HX
Stomp that were played, not arrangements of blocks Bender assembled from first
principles, which is the only way a starter tone is worth offering.

| Category | Starting point | Original name |
|---|---|---|
| Clean | Boutique Clean | Matchless CH2 SC |
| Crunch | Classic Crunch | Crunch |
| High Gain | Modern High Gain | 90s WaS |
| Lead | Sustaining Lead | Sakura Sustain Tap |
| Ambient Lead | Ambient Texture | After Play |
| Bass | Bass Rig | Bass |

Six, not thirty-seven, on purpose. This list exists for someone who does not
know what they want; handing that person a catalogue is the problem it is
supposed to solve. They are renamed for that audience too — "90s WaS" tells you
nothing unless you are the person who saved it. The original names are kept in
each file's `notes` field so provenance is not lost.

The rest of the owned collection lives in [`../corpus/`](../corpus/README.md).
Nothing was deleted; those presets are for compatibility testing and evaluation
rather than for showing to a beginner. A test fails if this directory grows past
eight presets or offers two starting points in the same category.

Every file is copied **byte for byte** from the device export. Nothing here has
been through Bender's serializer, which is what makes these files evidence about
the parser rather than about itself.

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
