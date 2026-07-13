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
        showToast('💾 저장 (Save)');
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z — redo
      if (meta && event.shiftKey && event.key === 'Z') {
        event.preventDefault();
        console.log('[sori-cut] Redo (placeholder)');
        showToast('↪️ 다시 실행 (Redo)');
        return;
      }

      // Ctrl+Z / Cmd+Z — undo
      if (meta && event.key === 'z') {
        event.preventDefault();
        console.log('[sori-cut] Undo (placeholder)');
        showToast('↩️ 되돌리기 (Undo)');
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
          showToast(next ? '▶️ 재생 (Play)' : '⏸️ 일시정지 (Pause)');
          break;
        }
        case 'Escape': {
          store.stopPlayback();
          showToast('⏹️ 정지 (Stop)');
          break;
        }
        case 'r':
        case 'R': {
          showToast('🎙️ 녹음 토글 (Record)');
          break;
        }
        case '[': {
          const pos = Math.max(0, store.playheadPosition - 5);
          store.setPlayheadPosition(pos);
          showToast('⏪ -5초 (Back 5s)');
          break;
        }
        case ']': {
          store.setPlayheadPosition(store.playheadPosition + 5);
          showToast('⏩ +5초 (Forward 5s)');
          break;
        }
        case 'm':
        case 'M': {
          const tracks = store.tracks;
          if (tracks.length > 0) {
            const firstTrack = tracks[0];
            store.toggleTrackMute(firstTrack.id);
            showToast(firstTrack.muted ? '🔊 음소거 해제 (Unmute)' : '🔇 음소거 (Mute)');
          }
          break;
        }
        case 'l':
        case 'L': {
          const next = !store.loopEnabled;
          store.setLoopEnabled(next);
          showToast(next ? '🔁 반복 켜기 (Loop On)' : '➡️ 반복 끄기 (Loop Off)');
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
