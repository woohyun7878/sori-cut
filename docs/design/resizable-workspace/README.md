# Resizable workspace

Desktop editor panes are independently resizable and collapsible while the narrow tool rail stays fixed. The workspace stores panel widths and collapsed state in `sori-cut:workspace-layout:v1`.

## Interaction

- Drag either vertical divider to resize its pane.
- Double-click a divider to restore the 300px default.
- Use Arrow keys for 8px steps or Shift+Arrow for 32px steps.
- Home restores the default width; End uses the current safe maximum.
- Collapse buttons leave a compact expand control in place.
- Below 1360px, the existing drawer and overlay interaction takes over and desktop sizing is ignored.

The preview retains at least 480px on desktop. Panel maxima tighten dynamically as the workspace narrows.

## Screenshots

- `default-1920x1080.png` — both panes at the 300px default.
- `left-wide-right-default-1920x1080.png` — left pane at 500px and inspector at 300px.
- `right-collapsed-1440x900.png` — compact inspector expand affordance.
- `drawer-fallback-1024x768.png` — contextual asset drawer over the small-screen workspace, despite persisted collapsed desktop panes.
