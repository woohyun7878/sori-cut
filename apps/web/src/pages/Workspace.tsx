import { useCallback, useState, type ReactNode } from 'react';
import { NavBar } from '../components/NavBar';
import { DropZone } from '../components/DropZone';
import { Toast } from '../components/Toast';
import { ShortcutHelpModal } from '../components/ShortcutHelpModal';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePresetStore } from '../store/usePresetStore';

/**
 * The Bender workspace shell.
 *
 * This screen establishes the regions the feature UI will drop into. Only the
 * brand area and the preset upload are wired to real behaviour; the signal
 * chain, request and changes regions are honest, clearly-labelled placeholders
 * that later phases replace. Nothing here fakes tone-editing behaviour.
 */
export function Workspace() {
  const [isHelpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const hasPreset = usePresetStore((state) => state.preset !== null);

  useKeyboardShortcuts(openHelp);

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-primary">
      <NavBar onOpenHelp={openHelp} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        {/* Brand / hero area */}
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
            To get started, drop a Helix <code className="rounded bg-surface-raised px-1 py-0.5 text-xs">.hlx</code>{' '}
            preset below.
          </p>
        </section>

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {/* Preset upload — wired to @bender/helix via the preset store. */}
          <RegionCard eyebrow="Preset" title="Upload">
            <DropZone />
          </RegionCard>

          {/* Signal-chain region — populated by the later signal-chain-view phase. */}
          <RegionCard eyebrow="Signal chain" title="Blocks &amp; routing">
            <Placeholder
              enabled={hasPreset}
              idle="Your amps, cabs and effects will appear here in signal-flow order once a preset is loaded."
              active="The signal-chain view arrives in a later phase — it will render this preset's blocks here."
            />
          </RegionCard>

          {/* Request region — populated by the later AI request / tool-calling phase. */}
          <RegionCard eyebrow="Request" title="Describe a tone change">
            <Placeholder
              enabled={hasPreset}
              idle="Tell Bender what you want in plain English. The chat request box lands in a later phase."
              active="The request box and AI tool-calling arrive in a later phase."
            />
          </RegionCard>

          {/* Changes / diff region — populated by the later diff / undo / download phase. */}
          <RegionCard eyebrow="Changes" title="Review &amp; download">
            <Placeholder
              enabled={hasPreset}
              idle="Proposed edits, the before/after diff, undo and the .hlx download will live here."
              active="The diff, undo and download controls arrive in a later phase."
            />
          </RegionCard>
        </div>
      </main>

      <ShortcutHelpModal isOpen={isHelpOpen} onClose={() => setHelpOpen(false)} />
      <Toast />
    </div>
  );
}

interface RegionCardProps {
  eyebrow: string;
  title: string;
  children: ReactNode;
}

/** A titled rack panel wrapping one workspace region. */
function RegionCard({ eyebrow, title, children }: RegionCardProps) {
  return (
    <section className="rack-panel flex flex-col">
      <div className="flex items-baseline justify-between border-b border-editor-border px-4 py-3">
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        <span className="eyebrow">{eyebrow}</span>
      </div>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}

interface PlaceholderProps {
  /** Whether a preset is loaded — changes only the copy, never fakes behaviour. */
  enabled: boolean;
  idle: string;
  active: string;
}

/** Honest empty-state body for a region a later phase fills in. */
function Placeholder({ enabled, idle, active }: PlaceholderProps) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 rounded-control border border-dashed border-editor-border bg-canvas/40 px-6 py-8 text-center">
      <span className="eyebrow text-brand-500/80">Coming soon</span>
      <p className="max-w-sm text-xs leading-5 text-muted">{enabled ? active : idle}</p>
    </div>
  );
}
