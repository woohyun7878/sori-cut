import { type StateCreator, type StoreApi, type StoreMutatorIdentifier } from 'zustand';

const MAX_HISTORY = 50;

/** Keys that should never be tracked in undo/redo history. */
const TRANSIENT_KEYS: ReadonlySet<string> = new Set([
  'playheadPosition',
  'isPlaying',
  'loopEnabled',
  'exportProgress',
  'isExporting',
]);

export interface UndoRedoState {
  pastStates: Record<string, unknown>[];
  futureStates: Record<string, unknown>[];
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

type UndoMiddleware = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  creator: StateCreator<T, Mps, Mcs>,
) => StateCreator<T & UndoRedoState, Mps, Mcs>;

/** Extract only the data keys (non-function, non-transient) from state. */
function getTrackedState(state: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};

  for (const key of Object.keys(state)) {
    if (TRANSIENT_KEYS.has(key)) continue;
    if (typeof state[key] === 'function') continue;
    // Skip undo/redo internal state
    if (key === 'pastStates' || key === 'futureStates' || key === 'canUndo' || key === 'canRedo') continue;
    snapshot[key] = state[key];
  }

  return snapshot;
}

/** Shallow-compare two snapshots to detect meaningful changes. */
function hasChanged(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return true;

  for (const key of keysA) {
    if (a[key] !== b[key]) return true;
  }

  return false;
}

export const undoMiddleware: UndoMiddleware =
  (creator) =>
  (set, get, api) => {
    let isUndoRedoing = false;
    let lastSnapshot: Record<string, unknown> | null = null;

    const wrappedSet: typeof set = (...args: Parameters<typeof set>) => {
      if (!isUndoRedoing) {
        const currentState = get() as Record<string, unknown>;
        const currentSnapshot = getTrackedState(currentState);

        // Apply the update first so we can compare
        (set as (...a: unknown[]) => void)(...args);

        const nextState = get() as Record<string, unknown>;
        const nextSnapshot = getTrackedState(nextState);

        if (hasChanged(currentSnapshot, nextSnapshot)) {
          const pastStates = [...(nextState.pastStates as Record<string, unknown>[]), currentSnapshot];

          if (pastStates.length > MAX_HISTORY) {
            pastStates.shift();
          }

          // Use original set to avoid recursion
          (set as (partial: Record<string, unknown>, replace?: boolean) => void)({
            pastStates,
            futureStates: [],
            canUndo: pastStates.length > 0,
            canRedo: false,
          });

          lastSnapshot = nextSnapshot;
        }

        return;
      }

      (set as (...a: unknown[]) => void)(...args);
    };

    const storeApi = api as StoreApi<Record<string, unknown>>;

    const undo = () => {
      const state = get() as Record<string, unknown>;
      const pastStates = state.pastStates as Record<string, unknown>[];

      if (pastStates.length === 0) return;

      const currentSnapshot = getTrackedState(state);
      const previousSnapshot = pastStates[pastStates.length - 1];
      const newPast = pastStates.slice(0, -1);
      const futureStates = [currentSnapshot, ...(state.futureStates as Record<string, unknown>[])];

      isUndoRedoing = true;
      storeApi.setState({
        ...previousSnapshot,
        pastStates: newPast,
        futureStates,
        canUndo: newPast.length > 0,
        canRedo: futureStates.length > 0,
      });
      lastSnapshot = previousSnapshot;
      isUndoRedoing = false;
    };

    const redo = () => {
      const state = get() as Record<string, unknown>;
      const futureStates = state.futureStates as Record<string, unknown>[];

      if (futureStates.length === 0) return;

      const currentSnapshot = getTrackedState(state);
      const nextSnapshot = futureStates[0];
      const newFuture = futureStates.slice(1);
      const pastStates = [...(state.pastStates as Record<string, unknown>[]), currentSnapshot];

      isUndoRedoing = true;
      storeApi.setState({
        ...nextSnapshot,
        pastStates,
        futureStates: newFuture,
        canUndo: pastStates.length > 0,
        canRedo: newFuture.length > 0,
      });
      lastSnapshot = nextSnapshot;
      isUndoRedoing = false;
    };

    const initialState = creator(wrappedSet, get, api);
    lastSnapshot = getTrackedState(initialState as Record<string, unknown>);

    return {
      ...initialState,
      pastStates: [] as Record<string, unknown>[],
      futureStates: [] as Record<string, unknown>[],
      canUndo: false,
      canRedo: false,
      undo,
      redo,
    };
  };
