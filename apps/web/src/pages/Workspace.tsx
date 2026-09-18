import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { NavBar } from '../components/NavBar';
import { ModeTabs, type WorkspaceMode } from '../components/ModeTabs';
import { StarterTones } from '../components/StarterTones';
import { RequestBox } from '../components/RequestBox';
import { PresetPane } from '../components/PresetPane';
import { Toast } from '../components/Toast';
import { ShortcutHelpModal } from '../components/ShortcutHelpModal';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePresetStore } from '../store/usePresetStore';

/**
 * The Bender workspace.
 *
 * Two ways in — a player-approved starter tone, or the preset already on your
 * rig — and one place the work happens: the agent conversation on the left,
 * the state of the preset on the right. The workspace renders before anything
 * is loaded, so the whole flow is visible without committing a file first.
 *
 * The chosen mode lives in the URL, so the browser's Back button steps between
 * the two panels and a link can point at either.
 */
export function Workspace() {
  const [isHelpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const view = usePresetStore((state) => state.view);

  useKeyboardShortcuts(openHelp);

  const mode: WorkspaceMode = searchParams.get('mode') === 'upload' ? 'upload' : 'tone';
  const setMode = useCallback(
    (next: WorkspaceMode) => {
      setSearchParams(next === 'upload' ? { mode: 'upload' } : {}, { replace: false });
    },
    [setSearchParams],
  );

  // Once a preset is open the hero has done its job; the workspace gets the screen.
  const compact = view !== null;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar onOpenHelp={openHelp} />

      <main className="mx-auto w-[min(1240px,calc(100%-48px))] flex-1 pb-16 pt-12 max-sm:w-[min(100%-32px,620px)] max-sm:pt-8">
        <section
          aria-labelledby="page-title"
          className={
            compact ? '' : 'grid grid-cols-[minmax(0,1fr)_420px] items-end gap-16 max-lg:grid-cols-1 max-lg:gap-4'
          }
        >
          <div>
            <p className="eyebrow-lit">Line 6 Helix · safe preset editing</p>
            <h1
              id="page-title"
              className={
                compact
                  ? 'mt-2 text-2xl font-semibold text-primary'
                  : 'mt-3 max-w-[780px] text-[clamp(42px,4.8vw,68px)] font-semibold leading-[0.98] text-primary'
              }
            >
              Shape your Helix tone.
            </h1>
          </div>
          {compact ? null : (
            <p className="mb-1 text-[15px] leading-[1.62] text-secondary">
              Begin with a player-approved foundation or bring the preset already on your rig.
              Bender shows every edit before you download it.
            </p>
          )}
        </section>

        <ModeTabs mode={mode} onChange={setMode} />

        {mode === 'tone' ? (
          <div id="tone-panel" role="tabpanel" aria-labelledby="tone-tab">
            <StarterTones onToneLoaded={() => setMode('upload')} />
          </div>
        ) : (
          <div id="upload-panel" role="tabpanel" aria-labelledby="upload-tab" className="mt-9">
            <div className="grid grid-cols-[minmax(0,1fr)_392px] items-start gap-[30px] max-lg:grid-cols-1">
              <RequestBox />
              <PresetPane />
            </div>
          </div>
        )}
      </main>

      <ShortcutHelpModal isOpen={isHelpOpen} onClose={() => setHelpOpen(false)} />
      <Toast />
    </div>
  );
}
