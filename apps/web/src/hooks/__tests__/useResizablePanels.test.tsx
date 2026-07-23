import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PANEL_WIDTH,
  LEFT_PANEL_MAX,
  MIN_PREVIEW_WIDTH,
  RIGHT_PANEL_MAX,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  parseWorkspaceLayout,
  persistWorkspaceLayout,
  resolveWorkspaceLayout,
  restoreWorkspaceLayout,
  useResizablePanels,
  type WorkspaceLayout,
} from '../useResizablePanels';

const defaultLayout: WorkspaceLayout = {
  version: 1,
  left: { width: DEFAULT_PANEL_WIDTH, collapsed: false },
  right: { width: DEFAULT_PANEL_WIDTH, collapsed: false },
};

function Harness() {
  const panels = useResizablePanels();

  return (
    <div ref={panels.containerRef} style={panels.style}>
      <output data-testid="left-width">{Math.round(panels.resolved.leftWidth)}</output>
      <output data-testid="right-width">{Math.round(panels.resolved.rightWidth)}</output>
      <button type="button" onClick={() => panels.togglePanel('left')}>
        Toggle left
      </button>
      <button type="button" onClick={() => panels.togglePanel('right')}>
        Toggle right
      </button>
      <div data-testid="left-splitter" {...panels.getSeparatorProps('left')} />
      <div data-testid="right-splitter" {...panels.getSeparatorProps('right')} />
    </div>
  );
}

describe('resizable workspace calculations', () => {
  it('clamps panel widths to their static bounds', () => {
    const resolved = resolveWorkspaceLayout(1920, {
      ...defaultLayout,
      left: { width: 999, collapsed: false },
      right: { width: -1, collapsed: false },
    });

    expect(resolved.leftWidth).toBe(LEFT_PANEL_MAX);
    expect(resolved.rightWidth).toBe(240);
  });

  it('tightens both panels dynamically to protect the preview width', () => {
    const resolved = resolveWorkspaceLayout(1360, {
      ...defaultLayout,
      left: { width: LEFT_PANEL_MAX, collapsed: false },
      right: { width: RIGHT_PANEL_MAX, collapsed: false },
    });

    expect(resolved.centerWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
    expect(resolved.leftWidth + resolved.rightWidth).toBeLessThan(LEFT_PANEL_MAX + RIGHT_PANEL_MAX);
    expect(resolved.leftMax).toBeLessThanOrEqual(LEFT_PANEL_MAX);
    expect(resolved.rightMax).toBeLessThanOrEqual(RIGHT_PANEL_MAX);
  });
});

describe('resizable workspace persistence', () => {
  it('restores valid versioned data', () => {
    const saved = {
      version: 1,
      left: { width: 410, collapsed: true },
      right: { width: 275, collapsed: false },
    };

    expect(parseWorkspaceLayout(JSON.stringify(saved))).toEqual(saved);
  });

  it.each([
    null,
    '{broken',
    JSON.stringify({ ...defaultLayout, version: 0 }),
    JSON.stringify({ ...defaultLayout, left: { width: 900, collapsed: false } }),
    JSON.stringify({ ...defaultLayout, right: { width: 300, collapsed: 'no' } }),
  ])('falls back to defaults for invalid or stale data', (saved) => {
    expect(parseWorkspaceLayout(saved)).toEqual(defaultLayout);
  });

  it('survives storage read and write failures', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('full');
      }),
    };

    expect(restoreWorkspaceLayout(storage)).toEqual(defaultLayout);
    expect(() => persistWorkspaceLayout(defaultLayout, storage)).not.toThrow();
  });
});

describe('useResizablePanels', () => {
  afterEach(cleanup);

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    class MockPointerEvent extends MouseEvent {
      pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: MockPointerEvent,
    });
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('collapses, expands, and persists each pane', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle left' }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? '{}').left).toEqual({
        width: 300,
        collapsed: true,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle left' }));
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? '{}').left.collapsed,
      ).toBe(false),
    );
  });

  it('resizes from the keyboard with intuitive right-pane direction and exposes ARIA values', () => {
    render(<Harness />);
    const left = screen.getByRole('separator', { name: 'Resize asset panel' });
    const right = screen.getByRole('separator', { name: 'Resize inspector panel' });

    expect(left).toHaveAttribute('aria-valuemin', '240');
    expect(left).toHaveAttribute('aria-valuemax', '520');
    expect(left).toHaveAttribute('aria-valuenow', '300');
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(left).toHaveAttribute('aria-valuenow', '308');
    fireEvent.keyDown(left, { key: 'ArrowRight', shiftKey: true });
    expect(left).toHaveAttribute('aria-valuenow', '340');

    fireEvent.keyDown(right, { key: 'ArrowLeft' });
    expect(right).toHaveAttribute('aria-valuenow', '308');
    fireEvent.keyDown(right, { key: 'ArrowRight' });
    expect(right).toHaveAttribute('aria-valuenow', '300');
    fireEvent.keyDown(right, { key: 'End' });
    expect(right).toHaveAttribute('aria-valuenow', String(RIGHT_PANEL_MAX));
  });

  it('resets a pane on double click and Home', () => {
    render(<Harness />);
    const left = screen.getByRole('separator', { name: 'Resize asset panel' });

    fireEvent.keyDown(left, { key: 'End' });
    expect(left).toHaveAttribute('aria-valuenow', String(LEFT_PANEL_MAX));
    fireEvent.doubleClick(left);
    expect(left).toHaveAttribute('aria-valuenow', String(DEFAULT_PANEL_WIDTH));
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    fireEvent.keyDown(left, { key: 'Home' });
    expect(left).toHaveAttribute('aria-valuenow', String(DEFAULT_PANEL_WIDTH));
  });

  it('uses pointer capture and disables text selection while dragging', () => {
    render(<Harness />);
    const splitter = screen.getByRole('separator', { name: 'Resize asset panel' });

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 7, clientX: 300 });
    expect(splitter.setPointerCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerMove(splitter, { pointerId: 7, clientX: 360 });
    expect(screen.getByTestId('left-width')).toHaveTextContent('360');
    fireEvent.pointerUp(splitter, { pointerId: 7 });
    expect(splitter.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.userSelect).toBe('');
  });

  it('restores persisted state on mount', () => {
    localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        left: { width: 420, collapsed: false },
        right: { width: 360, collapsed: true },
      }),
    );

    act(() => render(<Harness />));
    expect(screen.getByTestId('left-width')).toHaveTextContent('420');
    expect(screen.getByTestId('right-width')).toHaveTextContent('0');
  });
});

describe('resolveWorkspaceLayout responsive regression', () => {
  it('ensures preview center never goes below minimum at narrow container widths', () => {
    // Simulates a 768px tablet viewport at the desktop breakpoint
    const resolved = resolveWorkspaceLayout(1360, defaultLayout);
    expect(resolved.centerWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
  });

  it('collapses panel budget gracefully when container is exactly at breakpoint', () => {
    const maxLayout: WorkspaceLayout = {
      version: 1,
      left: { width: LEFT_PANEL_MAX, collapsed: false },
      right: { width: RIGHT_PANEL_MAX, collapsed: false },
    };
    const resolved = resolveWorkspaceLayout(1360, maxLayout);
    // Must never allow center to go below minimum
    expect(resolved.centerWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
    // Panels should be reduced
    expect(resolved.leftWidth).toBeLessThanOrEqual(LEFT_PANEL_MAX);
    expect(resolved.rightWidth).toBeLessThanOrEqual(RIGHT_PANEL_MAX);
  });

  it('handles both panels collapsed at narrow width', () => {
    const collapsedLayout: WorkspaceLayout = {
      version: 1,
      left: { width: DEFAULT_PANEL_WIDTH, collapsed: true },
      right: { width: DEFAULT_PANEL_WIDTH, collapsed: true },
    };
    const resolved = resolveWorkspaceLayout(1360, collapsedLayout);
    // When both collapsed, center gets maximum space
    expect(resolved.leftWidth).toBe(0);
    expect(resolved.rightWidth).toBe(0);
    expect(resolved.centerWidth).toBeGreaterThan(MIN_PREVIEW_WIDTH);
  });

  it('produces valid layout for very wide desktop (2560px)', () => {
    const resolved = resolveWorkspaceLayout(2560, defaultLayout);
    expect(resolved.centerWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
    expect(resolved.leftWidth).toBe(DEFAULT_PANEL_WIDTH);
    expect(resolved.rightWidth).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('panel max adapts when the other panel is large', () => {
    const asymmetric: WorkspaceLayout = {
      version: 1,
      left: { width: LEFT_PANEL_MAX, collapsed: false },
      right: { width: 240, collapsed: false },
    };
    const resolved = resolveWorkspaceLayout(1400, asymmetric);
    // Right max should be constrained by the large left panel
    expect(resolved.rightMax).toBeLessThanOrEqual(RIGHT_PANEL_MAX);
    expect(resolved.centerWidth).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
  });
});
