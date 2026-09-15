import { useEffect } from 'react';
import { usePresetStore } from '../store/usePresetStore';
import { showToast } from '../components/Toast';

function isInputFocused(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/**
 * Global keyboard shortcuts for the Bender workspace.
 *
 * Undo/redo act on the server-side edit history via the preset store, so they
 * are guarded by `canUndo` / `canRedo` and only confirm with a toast when
 * there was actually something to undo or redo.
 */
export function useKeyboardShortcuts(onOpenHelp: () => void) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      // Ctrl+Shift+Z / Cmd+Shift+Z — redo
      if (meta && event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        triggerRedo();
        return;
      }

      // Ctrl+Y / Cmd+Y — redo
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        triggerRedo();
        return;
      }

      // Ctrl+Z / Cmd+Z — undo
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        triggerUndo();
        return;
      }

      // Remaining shortcuts are single keys — ignore them while typing.
      if (isInputFocused(event)) return;

      if (event.key === '?') {
        onOpenHelp();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onOpenHelp]);
}

function triggerUndo() {
  const state = usePresetStore.getState();
  if (!state.canUndo) return;
  void state.undo();
  showToast('Undo');
}

function triggerRedo() {
  const state = usePresetStore.getState();
  if (!state.canRedo) return;
  void state.redo();
  showToast('Redo');
}
