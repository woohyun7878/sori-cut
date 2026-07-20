# sori-cut Studio Redesign Brief

## Decision

Use a **Fluent-first design system with selective Bebop expression**.

- Fluent provides the professional density, predictable controls, accessibility, and hierarchy needed for an editor.
- Bebop contributes brand personality through the logo, waveform colors, active states, onboarding moments, and primary actions.
- Do not imitate Moises or CapCut directly. Reuse proven editor patterns while keeping an original visual identity.

## Problem with the current UI

- Large cards consume space without adding hierarchy.
- The main video preview is not the visual center of the workspace.
- The timeline is too small for precise editing.
- Audio preparation, sync, and transport feel like separate forms rather than one production workflow.
- Excessive rounded borders and repeated section headings make the tool feel like a dashboard rather than an editor.
- Empty space dominates the canvas while high-value editing controls are compressed.

## Reference research

### CapCut patterns worth adopting

- Three-zone editor: asset browser, preview canvas, properties inspector.
- Full-width timeline across the bottom.
- Compact top command bar.
- Context-sensitive controls rather than large permanent cards.
- Dense but readable spacing and immediate drag/drop feedback.

### Moises patterns worth adopting

- Waveform-first representation of stems and takes.
- Music-specific controls grouped together: mute, solo, volume, tempo, count-in.
- Approachable track list and clear stem colors.
- Guided workflow that does not obscure the editing surface.

References:

- https://www.capcut.com/
- https://moises.ai/
- https://moises.ai/newsroom/product-announcements/new-moises-web-player/
- https://moises.ai/features/

## Target information architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ App bar: logo | project | save | workflow | undo/redo | export             │
├──────┬──────────────────────┬────────────────────────┬──────────────────────┤
│ Tool │ Assets / stems /     │ 9:16 preview canvas    │ Context inspector    │
│ rail │ recorded takes       │ + compact transport    │ Clip / Audio / Sync  │
│      │                      │                        │                       │
├──────┴──────────────────────┴────────────────────────┴──────────────────────┤
│ Timeline toolbar: select | split | snap | zoom | add track                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Video thumbnails                                                           │
│ Vocals waveform                                                             │
│ Drums waveform                                                              │
│ Bass waveform                                                               │
│ Other waveform                                                              │
│ Guitar take waveform                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Design system

### Color

- Canvas: `#0B0D10`
- Raised surface: `#12161B`
- Hover surface: `#1A2027`
- Border: `#29313A`
- Primary text: `#F7F8FA`
- Secondary text: `#A7B0BA`
- Brand violet: `#8B5CF6`
- Brand magenta: `#D946EF`
- Success/meter mint: `#4ADE80`
- Warning: `#F59E0B`
- Stem colors:
  - Vocals: violet
  - Drums: blue
  - Bass: teal
  - Other: orange
  - Guitar: yellow or magenta

### Shape

- 8px radius for controls.
- 10-12px radius for panels.
- Avoid 24-32px card radii in the editor.
- Borders should separate zones, not wrap every group.

### Spacing

- Base grid: 4px.
- Standard control height: 32px.
- Primary action height: 36px.
- Panel padding: 12-16px.
- Dense editor rows: 28-40px.

### Typography

- Use a neutral UI sans serif (Inter or system UI).
- 12px metadata, 13px controls, 14px labels, 16px panel headings.
- Reserve large display type for the landing page, not the editor.

### Motion

- 120-180ms state transitions.
- No bouncing or decorative motion in the editor.
- Use restrained Bebop expression for processing states and successful exports.

## Reference concepts

Three generated concepts accompany this brief:

1. `sori-cut-fluent-concept.png` — strongest structural reference.
2. `sori-cut-hybrid-concept.png` — strongest music workflow and workflow-step reference.
3. `sori-cut-bebop-concept.png` — strongest brand expression reference.

The implementation should follow the **Fluent concept's structure**, use the **hybrid concept's stem/take organization**, and borrow only the **Bebop concept's accent personality**.

## Implementation sequence

### PR 1 — Design references

- Commit this brief and all generated reference images under `docs/design/`.
- Add `docs/design/README.md` with the selected direction.
- No production code changes.

### PR 2 — Foundations and editor shell

- Add design tokens using CSS variables and Tailwind mappings.
- Replace oversized card-based Studio layout with:
  - compact app bar,
  - left tool rail,
  - asset panel,
  - preview center,
  - right inspector,
  - bottom timeline region.
- Preserve all current behaviors.
- Responsive fallback should collapse inspector/assets into drawers below desktop widths.

### PR 3 — Timeline and professional polish

- Increase timeline prominence and track density.
- Add clear track headers, M/S controls, source colors, and better waveform contrast.
- Add preview safe-area guides and compact transport.
- Normalize buttons, fields, focus rings, tooltips, and empty states.
- Add screenshot-based or component tests where practical.

## Definition of done

- The editor reads as a professional creative tool at first glance.
- The preview and timeline dominate the visual hierarchy.
- Users can identify the six-step workflow without navigating through large cards.
- Existing upload, stem separation, recording, sync, timeline, playback, and export flows still work.
- Tests, typecheck, and build pass.
