import { useCallback, useState, type ReactNode } from 'react';
import { NavBar } from '../components/NavBar';
import { DropZone } from '../components/DropZone';
import { StarterTones } from '../components/StarterTones';
import { SignalChain } from '../components/SignalChain';
import { RequestBox } from '../components/RequestBox';
import { ChangesPanel } from '../components/ChangesPanel';
import { Toast } from '../components/Toast';
import { ShortcutHelpModal } from '../components/ShortcutHelpModal';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePresetStore } from '../store/usePresetStore';

/**
 * The Bender workspace.
 *
 * Intake (upload + starter tones) is always available. Once a preset is open on
 * the server, the signal chain, the request box and the review/download panel
 * appear, all driven by the server-held session as the single source of truth.
 */
export function Workspace() {
  const [isHelpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const view = usePresetStore((state) => state.view);

  useKeyboardShortcuts(openHelp);

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-primary">
      <NavBar onOpenHelp={openHelp} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <section className="max-w-2xl">
          <p className="eyebrow">Bender · AI tone engineer</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-primary sm:text-4xl">
            Your AI guitar tone engineer.
          </h1>
          <p className="mt-3 text-sm leading-6 text-secondary">
            Bender reads your Line 6 Helix preset, shows its signal chain, and turns a plain-English
            request — <span className="text-primary">“more gain, tighter low end, a slower delay”</span> —
            into safe, reviewable edits. Inspect every change, undo anything, then download the
            modified <code className="rounded bg-surface-raised px-1 py-0.5 text-xs">.hlx</code>.
          </p>
          <p className="mt-3 text-sm text-muted">
            To get started, drop a Helix{' '}
            <code className="rounded bg-surface-raised px-1 py-0.5 text-xs">.hlx</code> preset below.
          </p>
        </section>

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <RegionCard eyebrow="Preset" title="Upload">
            <DropZone />
          </RegionCard>

          <RegionCard eyebrow="Starter tones" title="Beginner path">
            <StarterTones />
          </RegionCard>
        </div>

        {view ? (
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              <RegionCard eyebrow="Signal chain" title="Blocks &amp; routing">
                <PresetMeta />
                <SignalChain chain={view.chain} diff={view.diff} />
              </RegionCard>

              <RegionCard eyebrow="Changes" title="Review &amp; download">
                <ChangesPanel />
              </RegionCard>
            </div>

            <RegionCard
              eyebrow="Request"
              title="Describe a tone change"
              className="self-start lg:sticky lg:top-20"
            >
              <RequestBox />
            </RegionCard>
          </div>
        ) : (
          <p className="mt-5 text-sm text-muted">
            Upload a preset to see its signal chain, ask Bender for changes, and download the result.
          </p>
        )}
      </main>

      <ShortcutHelpModal isOpen={isHelpOpen} onClose={() => setHelpOpen(false)} />
      <Toast />
    </div>
  );
}

/** A compact identity line for the loaded preset, above the chain. */
function PresetMeta() {
  const view = usePresetStore((state) => state.view);
  if (!view) return null;

  const parts = [
    view.device,
    view.firmware ? `FW ${view.firmware}` : null,
    view.tempo ? `${view.tempo} BPM` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-editor-border pb-3">
      <span className="text-sm font-semibold text-primary">{view.name ?? view.filename}</span>
      {parts.length > 0 ? <span className="text-xs text-muted">{parts.join(' · ')}</span> : null}
    </div>
  );
}

interface RegionCardProps {
  eyebrow: string;
  title: string;
  children: ReactNode;
  className?: string;
}

/** A titled rack panel wrapping one workspace region. */
function RegionCard({ eyebrow, title, children, className }: RegionCardProps) {
  return (
    <section className={['rack-panel flex flex-col', className ?? ''].join(' ')}>
      <div className="flex items-baseline justify-between border-b border-editor-border px-4 py-3">
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        <span className="eyebrow">{eyebrow}</span>
      </div>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}
