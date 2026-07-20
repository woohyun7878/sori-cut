import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'sori-cut:workspace-layout:v1';
export const WORKSPACE_LAYOUT_VERSION = 1;
export const DESKTOP_BREAKPOINT = 1360;
export const TOOL_RAIL_WIDTH = 56;
export const SPLITTER_WIDTH = 8;
export const COLLAPSED_PANE_WIDTH = 36;
export const MIN_PREVIEW_WIDTH = 480;
export const LEFT_PANEL_MIN = 240;
export const LEFT_PANEL_MAX = 520;
export const RIGHT_PANEL_MIN = 240;
export const RIGHT_PANEL_MAX = 480;
export const DEFAULT_PANEL_WIDTH = 300;

export type PanelSide = 'left' | 'right';

export interface PanelState {
  width: number;
  collapsed: boolean;
}

export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  left: PanelState;
  right: PanelState;
}

export interface ResolvedWorkspaceLayout {
  leftWidth: number;
  rightWidth: number;
  leftMin: number;
  leftMax: number;
  rightMin: number;
  rightMax: number;
  centerWidth: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface DragState {
  side: PanelSide;
  pointerId: number;
  startX: number;
  startWidth: number;
  target: HTMLElement;
  previousUserSelect: string;
  previousCursor: string;
}

const DEFAULT_LAYOUT: WorkspaceLayout = {
  version: WORKSPACE_LAYOUT_VERSION,
  left: { width: DEFAULT_PANEL_WIDTH, collapsed: false },
  right: { width: DEFAULT_PANEL_WIDTH, collapsed: false },
};

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isPanelState(value: unknown, minimum: number, maximum: number): value is PanelState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const panel = value as Partial<PanelState>;
  return (
    typeof panel.width === 'number' &&
    Number.isFinite(panel.width) &&
    panel.width >= minimum &&
    panel.width <= maximum &&
    typeof panel.collapsed === 'boolean'
  );
}

export function parseWorkspaceLayout(value: string | null): WorkspaceLayout {
  if (!value) {
    return structuredClone(DEFAULT_LAYOUT);
  }

  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceLayout>;
    if (
      parsed.version !== WORKSPACE_LAYOUT_VERSION ||
      !isPanelState(parsed.left, LEFT_PANEL_MIN, LEFT_PANEL_MAX) ||
      !isPanelState(parsed.right, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
    ) {
      return structuredClone(DEFAULT_LAYOUT);
    }

    return {
      version: WORKSPACE_LAYOUT_VERSION,
      left: { ...parsed.left },
      right: { ...parsed.right },
    };
  } catch {
    return structuredClone(DEFAULT_LAYOUT);
  }
}

export function restoreWorkspaceLayout(storage?: StorageLike): WorkspaceLayout {
  if (!storage) {
    return structuredClone(DEFAULT_LAYOUT);
  }

  try {
    return parseWorkspaceLayout(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY));
  } catch {
    return structuredClone(DEFAULT_LAYOUT);
  }
}

export function persistWorkspaceLayout(layout: WorkspaceLayout, storage?: StorageLike) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Layout persistence is optional; editor rendering must remain available.
  }
}

export function resolveWorkspaceLayout(
  containerWidth: number,
  layout: WorkspaceLayout,
): ResolvedWorkspaceLayout {
  const leftOpen = !layout.left.collapsed;
  const rightOpen = !layout.right.collapsed;
  const chromeWidth =
    TOOL_RAIL_WIDTH +
    (leftOpen ? SPLITTER_WIDTH : COLLAPSED_PANE_WIDTH) +
    (rightOpen ? SPLITTER_WIDTH : COLLAPSED_PANE_WIDTH);
  const panelBudget = Math.max(0, containerWidth - chromeWidth - MIN_PREVIEW_WIDTH);

  let leftWidth = leftOpen ? clamp(layout.left.width, LEFT_PANEL_MIN, LEFT_PANEL_MAX) : 0;
  let rightWidth = rightOpen ? clamp(layout.right.width, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX) : 0;
  const minimumTotal = (leftOpen ? LEFT_PANEL_MIN : 0) + (rightOpen ? RIGHT_PANEL_MIN : 0);
  const usableBudget = Math.max(minimumTotal, panelBudget);
  const overflow = Math.max(0, leftWidth + rightWidth - usableBudget);

  if (overflow > 0) {
    const leftFlex = leftOpen ? leftWidth - LEFT_PANEL_MIN : 0;
    const rightFlex = rightOpen ? rightWidth - RIGHT_PANEL_MIN : 0;
    const totalFlex = leftFlex + rightFlex;
    const leftReduction = totalFlex > 0 ? Math.min(leftFlex, (overflow * leftFlex) / totalFlex) : 0;
    leftWidth -= leftReduction;
    rightWidth -= Math.min(rightFlex, overflow - leftReduction);
  }

  const leftMax = leftOpen
    ? clamp(panelBudget - rightWidth, LEFT_PANEL_MIN, LEFT_PANEL_MAX)
    : LEFT_PANEL_MAX;
  const rightMax = rightOpen
    ? clamp(panelBudget - leftWidth, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
    : RIGHT_PANEL_MAX;
  const centerWidth = Math.max(
    MIN_PREVIEW_WIDTH,
    containerWidth - chromeWidth - leftWidth - rightWidth,
  );

  return {
    leftWidth,
    rightWidth,
    leftMin: LEFT_PANEL_MIN,
    leftMax,
    rightMin: RIGHT_PANEL_MIN,
    rightMax,
    centerWidth,
  };
}

function getBrowserStorage(): StorageLike | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function getInitialContainerWidth() {
  return typeof window === 'undefined' ? 1920 : window.innerWidth;
}

export function useResizablePanels() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(getInitialContainerWidth);
  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    restoreWorkspaceLayout(getBrowserStorage()),
  );
  const resolved = useMemo(
    () => resolveWorkspaceLayout(containerWidth, layout),
    [containerWidth, layout],
  );
  const resolvedRef = useRef(resolved);
  const layoutRef = useRef(layout);
  const dragRef = useRef<DragState | null>(null);

  layoutRef.current = layout;

  useEffect(() => {
    resolvedRef.current = resolved;
  }, [resolved]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => persistWorkspaceLayout(layout, getBrowserStorage()),
      120,
    );
    return () => window.clearTimeout(timeout);
  }, [layout]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (width > 0) {
        setContainerWidth(width);
      }
    };
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) {
        setContainerWidth(width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const finishDrag = useCallback((pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) {
      return;
    }

    if (drag.target.hasPointerCapture?.(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId);
    }
    document.body.style.userSelect = drag.previousUserSelect;
    document.body.style.cursor = drag.previousCursor;
    dragRef.current = null;
  }, []);

  useEffect(
    () => () => {
      finishDrag();
      persistWorkspaceLayout(layoutRef.current, getBrowserStorage());
    },
    [finishDrag],
  );

  const resizePanel = useCallback((side: PanelSide, width: number) => {
    const limits = resolvedRef.current;
    const minimum = side === 'left' ? limits.leftMin : limits.rightMin;
    const maximum = side === 'left' ? limits.leftMax : limits.rightMax;
    setLayout((current) => ({
      ...current,
      [side]: {
        ...current[side],
        width: clamp(width, minimum, maximum),
      },
    }));
  }, []);

  const resetPanel = useCallback(
    (side: PanelSide) => resizePanel(side, DEFAULT_PANEL_WIDTH),
    [resizePanel],
  );

  const setPanelCollapsed = useCallback((side: PanelSide, collapsed: boolean) => {
    setLayout((current) => ({
      ...current,
      [side]: { ...current[side], collapsed },
    }));
  }, []);

  const togglePanel = useCallback((side: PanelSide) => {
    setLayout((current) => ({
      ...current,
      [side]: { ...current[side], collapsed: !current[side].collapsed },
    }));
  }, []);

  const handlePointerDown = useCallback(
    (side: PanelSide, event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      finishDrag();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const currentResolved = resolvedRef.current;
      dragRef.current = {
        side,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: side === 'left' ? currentResolved.leftWidth : currentResolved.rightWidth,
        target,
        previousUserSelect: document.body.style.userSelect,
        previousCursor: document.body.style.cursor,
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      event.preventDefault();
    },
    [finishDrag],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const delta = event.clientX - drag.startX;
      resizePanel(drag.side, drag.startWidth + (drag.side === 'left' ? delta : -delta));
    },
    [resizePanel],
  );

  const handleKeyDown = useCallback(
    (side: PanelSide, event: KeyboardEvent<HTMLDivElement>) => {
      const limits = resolvedRef.current;
      const currentWidth = side === 'left' ? limits.leftWidth : limits.rightWidth;
      const minimum = side === 'left' ? limits.leftMin : limits.rightMin;
      const maximum = side === 'left' ? limits.leftMax : limits.rightMax;
      const step = event.shiftKey ? 32 : 8;
      let nextWidth: number | null = null;

      if (event.key === 'Home') {
        nextWidth = clamp(DEFAULT_PANEL_WIDTH, minimum, maximum);
      } else if (event.key === 'End') {
        nextWidth = maximum;
      } else if (event.key === 'ArrowLeft') {
        nextWidth = currentWidth + (side === 'right' ? step : -step);
      } else if (event.key === 'ArrowRight') {
        nextWidth = currentWidth + (side === 'left' ? step : -step);
      }

      if (nextWidth !== null) {
        event.preventDefault();
        resizePanel(side, nextWidth);
      }
    },
    [resizePanel],
  );

  const getSeparatorProps = useCallback(
    (side: PanelSide) => {
      const minimum = side === 'left' ? resolved.leftMin : resolved.rightMin;
      const maximum = side === 'left' ? resolved.leftMax : resolved.rightMax;
      const value = side === 'left' ? resolved.leftWidth : resolved.rightWidth;
      const label = side === 'left' ? 'Resize asset panel' : 'Resize inspector panel';

      return {
        role: 'separator',
        'aria-orientation': 'vertical' as const,
        'aria-valuemin': Math.round(minimum),
        'aria-valuemax': Math.round(maximum),
        'aria-valuenow': Math.round(value),
        'aria-label': label,
        tabIndex: 0,
        title:
          'Drag to resize. Arrow keys: 8px; Shift+Arrow: 32px; Home: default; End: maximum; double-click: reset.',
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => handlePointerDown(side, event),
        onPointerMove: handlePointerMove,
        onPointerUp: (event: PointerEvent<HTMLDivElement>) => finishDrag(event.pointerId),
        onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finishDrag(event.pointerId),
        onDoubleClick: () => resetPanel(side),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => handleKeyDown(side, event),
      };
    },
    [finishDrag, handleKeyDown, handlePointerDown, handlePointerMove, resetPanel, resolved],
  );

  const style = {
    '--left-panel-width': `${resolved.leftWidth}px`,
    '--right-panel-width': `${resolved.rightWidth}px`,
    '--left-pane-column': layout.left.collapsed
      ? `${COLLAPSED_PANE_WIDTH}px`
      : `${resolved.leftWidth}px`,
    '--right-pane-column': layout.right.collapsed
      ? `${COLLAPSED_PANE_WIDTH}px`
      : `${resolved.rightWidth}px`,
    '--left-splitter-width': layout.left.collapsed ? '0px' : `${SPLITTER_WIDTH}px`,
    '--right-splitter-width': layout.right.collapsed ? '0px' : `${SPLITTER_WIDTH}px`,
    '--min-preview-width': `${MIN_PREVIEW_WIDTH}px`,
  } as CSSProperties;

  return {
    containerRef,
    layout,
    resolved,
    style,
    getSeparatorProps,
    resetPanel,
    resizePanel,
    setPanelCollapsed,
    togglePanel,
  };
}
