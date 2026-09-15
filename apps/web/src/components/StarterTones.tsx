import { useEffect, useState } from 'react';
import { getTemplates } from '../api/client';
import type { TemplateSummary } from '../api/types';
import { usePresetStore } from '../store/usePresetStore';

/**
 * The beginner path: curated starter tones.
 *
 * The backend returns an empty list on purpose — Bender only ships a starter
 * preset once a real player has dialled and approved one, rather than
 * fabricating plausible-looking blocks nobody has heard. So the empty state is
 * stated honestly rather than hidden, and real templates render as soon as any
 * exist.
 */
export function StarterTones() {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadTemplate = usePresetStore((state) => state.loadTemplate);
  const isUploading = usePresetStore((state) => state.isUploading);

  useEffect(() => {
    let active = true;
    getTemplates()
      .then((result) => {
        if (active) setTemplates(result);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load starter tones.');
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return <p className="text-xs leading-5 text-muted">{error}</p>;
  }

  if (templates === null) {
    return <p className="text-xs leading-5 text-muted">Loading starter tones…</p>;
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-control border border-dashed border-editor-border bg-canvas/40 px-4 py-6 text-center">
        <p className="text-sm font-medium text-secondary">No starter tones yet</p>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-muted">
          Bender ships starter presets only when a real player has dialled and approved them —
          never invented ones. Upload your own <code className="rounded bg-surface-raised px-1 py-0.5">.hlx</code>{' '}
          above to get going.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {templates.map((template) => (
        <li key={template.id}>
          <button
            type="button"
            onClick={() => void loadTemplate(template.id)}
            disabled={isUploading}
            className="w-full rounded-control border border-editor-border bg-surface-raised px-3 py-2.5 text-left transition-colors hover:border-brand-600/60 disabled:opacity-60"
          >
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-primary">{template.name}</span>
              <span className="eyebrow ml-auto">{template.category}</span>
            </span>
            <span className="mt-1 block text-xs leading-5 text-muted">{template.summary}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
