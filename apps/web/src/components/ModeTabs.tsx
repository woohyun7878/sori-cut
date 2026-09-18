import type { KeyboardEvent } from 'react';

export type WorkspaceMode = 'tone' | 'upload';

interface ModeTabsProps {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}

const TABS: ReadonlyArray<{ id: WorkspaceMode; label: string; icon: JSX.Element }> = [
  {
    id: 'tone',
    label: 'Start with a tone',
    icon: (
      <path
        d="M2 12h3l2.5-7 4 14L14 9l2 3h6"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    id: 'upload',
    label: 'Upload a preset',
    icon: (
      <path
        d="M12 16V4M12 4L8 8M12 4L16 8M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
];

/**
 * How to begin: from a player-approved foundation, or from the preset already
 * on your rig.
 *
 * Follows the ARIA tabs pattern — arrow keys move between tabs and only the
 * selected one is in the tab order — because the two panels are alternate
 * views of the same task rather than separate pages.
 */
export function ModeTabs({ mode, onChange }: ModeTabsProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === mode);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    onChange(next.id);
    document.getElementById(`${next.id}-tab`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Choose how to begin"
      onKeyDown={handleKeyDown}
      className="mt-8 inline-grid grid-cols-2 rounded-editor border border-editor-border bg-white/[0.02] p-1 max-sm:w-full"
    >
      {TABS.map((tab) => {
        const selected = tab.id === mode;
        return (
          <button
            key={tab.id}
            id={`${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${tab.id}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={[
              'flex min-w-[196px] items-center justify-center gap-2.5 rounded-control px-5 py-2.5 text-sm font-semibold transition-colors max-sm:min-w-0 max-sm:px-2.5',
              selected ? 'bg-primary text-canvas' : 'text-muted hover:text-secondary',
            ].join(' ')}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {tab.icon}
            </svg>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
