# Studio visual QA

This pass applies a 4px spacing rhythm to the post-PR-#35 editor shell.

## Spacing rules

- Spacing steps: 4, 8, 12, 16, 24, and 32px.
- Standard controls: 32px; primary actions: 36px.
- Panel padding: 12px; dialog padding: 16px.
- Timeline toolbar: 36px; ruler: 28px; track rows: 48px.
- Controls and compact surfaces use an 8px radius; panels use a 10px radius.

## Fixes

- Desktop panels now remain drawers until 1360px, preserving preview space at 1280px.
- Shared shell, panel, control, and timeline dimensions replace unrelated one-off values.
- Timeline headers and lanes use the same row token, with a wider 208px track-control column.
- The timeline has one intentional scroll container instead of nested scrolling surfaces.
- Preview tools, project controls, dialogs, menus, and confirmation actions share compact geometry.
- Track labels, controls, ruler, clips, and playhead align to the same grid.

## Screenshots

Final populated-state captures:

- `after-1920x1080.png`
- `after-1440x900.png`
- `after-1280x800.png`
- `after-1024x768.png`

The paired `before` captures at 1280x800 and 1024x768 show the responsive and timeline-density changes.
