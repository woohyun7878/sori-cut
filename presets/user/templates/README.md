# Starter templates

Presets offered to users who arrive without one. This covers the second MVP
user type: someone who knows what they want to *sound* like but not which
knobs produce it.

## Why this directory is empty

Bender ships no starter presets. A convincing starter tone has to come from a
real preset someone made and owns — anything Bender generated from first
principles would be a plausible-looking arrangement of blocks that nobody has
ever heard. The UI says so plainly rather than presenting invented presets as
curated ones.

Drop in presets you own and they appear as starting points automatically.

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
  "device": 2162689,
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
