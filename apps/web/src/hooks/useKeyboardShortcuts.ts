import { useEffect } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { showToast } from '../components/Toast';

function isInputFocused(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useKeyboardShortcuts(onOpenHelp: () => void) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      // Ctrl+S / Cmd+S — save project
      if (meta && event.key === 's') {
        event.preventDefault();
        showToast('💾 Saved');
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z — redo
      if (meta && event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        useProjectStore.getState().redo();
        showToast('↪️ Redo');
        return;
      }

      // Ctrl+Y / Cmd+Y — redo
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        useProjectStore.getState().redo();
        showToast('↪️ Redo');
        return;
      }

      // Ctrl+Z / Cmd+Z — undo
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        useProjectStore.getState().undo();
        showToast('↩️ Undo');
        return;
      }

      // Skip shortcuts when typing in inputs
      if (isInputFocused(event)) return;

      const store = useProjectStore.getState();

      switch (event.key) {
        case ' ': {
          event.preventDefault();
          const next = !store.isPlaying;
          store.setIsPlaying(next);
          showToast(next ? '▶️ Play' : '⏸️ Pause');
          break;
        }
        case 'Escape': {
          store.stopPlayback();
          showToast('⏹️ Stop');
          break;
        }
        case 'r':
        case 'R': {
          showToast('🎙️ Record');
          break;
        }
        case '[': {
          const pos = Math.max(0, store.playheadPosition - 5);
          store.setPlayheadPosition(pos);
          showToast('⏪ Back 5s');
          break;
        }
        case ']': {
          store.setPlayheadPosition(store.playheadPosition + 5);
          showToast('⏩ Forward 5s');
          break;
        }
        case 'm':
        case 'M': {
          const selectedTrack = store.selectedTrackId
            ? store.tracks.find((track) => track.id === store.selectedTrackId)
            : undefined;

          if (!selectedTrack) {
            showToast('⚠️ Select a track first');
            break;
          }

          store.toggleTrackMute(selectedTrack.id);
          showToast(selectedTrack.muted ? '🔊 Unmuted' : '🔇 Muted');
          break;
        }
        case 'l':
        case 'L': {
          const next = !store.loopEnabled;
          store.setLoopEnabled(next);
          showToast(next ? '🔁 Loop On' : '➡️ Loop Off');
          break;
        }
        case '?': {
          onOpenHelp();
          break;
        }
        default:
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onOpenHelp]);
}
