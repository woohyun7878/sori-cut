import { useEffect, useRef, useState } from 'react';
import { getTemplates } from '../api/client';
import type { TemplateSummary } from '../api/types';
import { usePresetStore } from '../store/usePresetStore';
import { toneLook, toneNumber } from '../lib/toneArt';
import { ChainPreview } from './ChainPreview';

/**
 * The beginner path: player-approved starter tones.
 *
 * The rail is native horizontal scrolling with snap points, so it can be
 * swiped on a phone and keyboard focus scrolls a card into view on its own;
 * the arrow buttons are an enhancement rather than the only way through.
 *
 * Selecting a card is free — it only moves the preview. Loading happens when
 * the player commits with "Use this tone", which opens a server session and
 * hands the workspace over.
 */

interface StarterTonesProps {
  /** Called once a tone has been loaded, to hand over to the workspace. */
  onToneLoaded: () => void;
}

export function StarterTones({ onToneLoaded }: StarterTonesProps) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getTemplates()
      .then((result) => {
        if (!active) return;
        setTemplates(result);
        setSelectedId(result[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load starter tones.');
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <section aria-labelledby="tones-heading" className="mt-9">
        <SectionHeading count={null} />
        <p className="rounded-editor border border-danger/40 bg-danger/[0.09] px-4 py-3 text-sm text-secondary">
          {error}
        </p>
      </section>
    );
  }

  if (templates === null) {
    return (
      <section aria-labelledby="tones-heading" className="mt-9">
        <SectionHeading count={null} />
        <p className="text-xs leading-5 text-muted">Loading starter tones…</p>
      </section>
    );
  }

  if (templates.length === 0) {
    return (
      <section aria-labelledby="tones-heading" className="mt-9">
        <SectionHeading count={0} />
        <div className="rounded-editor border border-dashed border-editor-border-strong px-4 py-8 text-center">
          <p className="text-sm font-medium text-secondary">No starter tones yet</p>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-muted">
            Bender ships starter presets only when a real player has dialled and approved them —
            never invented ones. Upload your own <code className="font-mono">.hlx</code> instead.
          </p>
        </div>
      </section>
    );
  }

  const selected = templates.find((template) => template.id === selectedId) ?? templates[0];

  return (
    <section aria-labelledby="tones-heading" className="mt-9">
      <ToneRail
        templates={templates}
        selectedId={selected.id}
        onSelect={setSelectedId}
      />
      <TonePreview template={selected} index={templates.indexOf(selected)} onToneLoaded={onToneLoaded} />
      <p className="rule-note mt-7">
        Every starter tone is a real .hlx preset dialled and approved by a player.
      </p>
    </section>
  );
}

function SectionHeading({ count, children }: { count: number | null; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-6">
      <div>
        <p className="eyebrow-lit">
          Player-approved foundations{count === null ? '' : ` · ${String(count).padStart(2, '0')}`}
        </p>
        <h2 id="tones-heading" className="mt-1.5 text-[22px] font-semibold text-primary">
          Choose where your sound begins
        </h2>
      </div>
      {children}
    </div>
  );
}

interface ToneRailProps {
  templates: TemplateSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}

function ToneRail({ templates, selectedId, onSelect }: ToneRailProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const syncEdges = () => {
    const el = viewportRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    // A one-pixel slack: fractional layout widths never land exactly on zero.
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  };

  useEffect(() => {
    syncEdges();
    window.addEventListener('resize', syncEdges);
    return () => window.removeEventListener('resize', syncEdges);
    // Re-measure when the rail's contents change, not just on mount.
  }, [templates.length]);

  const page = (direction: -1 | 1) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(el.clientWidth * 0.9, 240) });
  };

  return (
    <>
      <SectionHeading count={templates.length}>
        <div className="flex gap-2" role="group" aria-label="Browse starter tones">
          <button
            type="button"
            onClick={() => page(-1)}
            disabled={atStart}
            aria-label="Previous tones"
            className="btn-secondary h-9 w-9 px-0 text-lg"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => page(1)}
            disabled={atEnd}
            aria-label="Next tones"
            className="btn-secondary h-9 w-9 px-0 text-lg"
          >
            →
          </button>
        </div>
      </SectionHeading>

      <div
        ref={viewportRef}
        onScroll={syncEdges}
        className="scroll-rail"
        role="group"
        aria-label="Starter tones"
      >
        <div className="grid auto-cols-[274px] grid-flow-col gap-3 pb-0.5 max-sm:auto-cols-[min(82vw,296px)]">
          {templates.map((template, index) => (
            <ToneCard
              key={template.id}
              template={template}
              index={index}
              selected={template.id === selectedId}
              onSelect={() => onSelect(template.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

interface ToneCardProps {
  template: TemplateSummary;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

function ToneCard({ template, index, selected, onSelect }: ToneCardProps) {
  const look = toneLook(template.category, index);
  const inUse = usePresetStore((state) => state.sourceTemplateId) === template.id;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{ '--tone': look.color } as React.CSSProperties}
      className="tone-card relative flex min-h-[158px] snap-start flex-col justify-between gap-[18px] overflow-hidden rounded-editor border border-editor-border-strong bg-surface px-[17px] py-[15px] text-left transition-colors duration-150"
    >
      <span className={`tone-art ${look.art}`} aria-hidden="true" />

      <span className="relative flex items-center justify-between gap-3">
        <span className="tone-index font-mono text-[10px] font-semibold uppercase tracking-[0.14em]">
          Tone {toneNumber(index)} · {template.category}
        </span>
        <span
          aria-hidden="true"
          className={[
            'h-[15px] w-[15px] flex-none rounded-full border',
            selected
              ? 'border-brand-500 bg-[radial-gradient(circle,rgb(var(--color-brand))_0_42%,transparent_43%)]'
              : 'border-editor-border-strong',
          ].join(' ')}
        />
      </span>

      <span className="relative block">
        <span className="block text-[19px] font-semibold leading-tight text-primary">
          {template.name}
        </span>
        <span className="mt-2 block text-xs leading-[1.45] text-secondary">
          {template.summary}
        </span>
        {inUse ? <span className="pill pill-ok mt-2.5">In use</span> : null}
      </span>
    </button>
  );
}

interface TonePreviewProps {
  template: TemplateSummary;
  index: number;
  onToneLoaded: () => void;
}

function TonePreview({ template, index, onToneLoaded }: TonePreviewProps) {
  const loadTemplate = usePresetStore((state) => state.loadTemplate);
  const isUploading = usePresetStore((state) => state.isUploading);
  const view = usePresetStore((state) => state.view);
  const sourceTemplateId = usePresetStore((state) => state.sourceTemplateId);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const isLoaded = sourceTemplateId === template.id && view !== null;
  const busy = pendingId === template.id;

  const applyTone = async () => {
    if (isLoaded) {
      onToneLoaded();
      return;
    }
    setPendingId(template.id);
    await loadTemplate(template.id);
    setPendingId(null);
    // `loadTemplate` swallows its own failures into `uploadError`, so read the
    // store rather than trusting the call to have succeeded.
    if (usePresetStore.getState().sourceTemplateId === template.id) onToneLoaded();
  };

  const look = toneLook(template.category, index);

  return (
    <div className="mt-7 grid grid-cols-[300px_minmax(0,1fr)_200px] items-center gap-[34px] border-t border-editor-border pt-7 max-lg:grid-cols-2 max-sm:grid-cols-1 max-sm:gap-6">
      <div>
        <p className="eyebrow-lit">Selected foundation</p>
        <h3 className="my-2 text-[21px] font-semibold text-primary">{template.name}</h3>
        <p className="text-[13px] leading-[1.55] text-secondary">{template.summary}</p>
      </div>

      <div className="min-w-0 max-lg:col-span-2 max-sm:col-span-1">
        {isLoaded && view ? (
          <ChainPreview
            chain={view.chain}
            caption={`${view.chain.filter((block) => block.role === 'block').length} blocks · ${view.device ?? 'Helix'}${view.firmware ? ` · firmware ${view.firmware}` : ''}`}
          />
        ) : (
          <BestFor template={template} color={look.color} />
        )}
      </div>

      <div className="max-lg:col-span-2 max-sm:col-span-1">
        <button type="button" onClick={() => void applyTone()} disabled={busy} className="btn-primary w-full">
          {busy ? 'Loading…' : isLoaded ? 'Continue →' : 'Use this tone →'}
        </button>
        <p className="mt-2.5 text-center text-[10px] leading-snug text-muted">
          {isUploading && !busy
            ? 'Another preset is opening…'
            : 'Next: tell Bender what you want to change'}
        </p>
      </div>
    </div>
  );
}

/**
 * What the tone is for, before it is loaded.
 *
 * The signal chain only exists once the server opens a session, and inventing
 * a plausible one here would be exactly the kind of decorative fiction the
 * starter tones are meant to avoid. `bestFor` is real metadata the backend
 * already returns.
 */
function BestFor({ template, color }: { template: TemplateSummary; color: string }) {
  const bestFor = template.bestFor ?? [];

  if (bestFor.length === 0) {
    return (
      <p className="text-[11px] leading-5 text-muted">
        Its signal chain appears here once the tone is loaded.
      </p>
    );
  }

  return (
    <div className="min-w-0">
      <p className="eyebrow mb-2.5">Best for</p>
      <ul className="flex flex-wrap gap-2">
        {bestFor.map((entry) => (
          <li
            key={entry}
            style={{ borderColor: color }}
            className="rounded-control border bg-white/[0.015] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.05em] text-secondary"
          >
            {entry}
          </li>
        ))}
      </ul>
    </div>
  );
}
