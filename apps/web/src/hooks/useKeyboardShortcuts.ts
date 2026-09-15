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
 * Deliberately minimal for the shell: undo/redo of preset changes plus the
 * shortcut-help overlay. Feature-specific shortcuts (accept a tone change,
 * download the edited preset, focus the request box) arrive with their
 * features in a later phase.
 */
export function useKeyboardShortcuts(onOpenHelp: () => void) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      // Ctrl+Shift+Z / Cmd+Shift+Z — redo
      if (meta && event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        usePresetStore.getState().redo();
        showToast('Redo');
        return;
      }

      // Ctrl+Y / Cmd+Y — redo
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        usePresetStore.getState().redo();
        showToast('Redo');
        return;
      }

      // Ctrl+Z / Cmd+Z — undo
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        usePresetStore.getState().undo();
        showToast('Undo');
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
