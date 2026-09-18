import { useEffect, useState } from 'react';
import { getHealth } from '../api/client';

/**
 * The model family Bender talks to, for display only.
 *
 * The deployment name and endpoint stay server-side; this is the public family
 * name, which is what a player actually wants to know. Update it here if the
 * backend is pointed at a different family.
 */
const MODEL_LABEL = 'GPT-5-mini';

type Health = 'checking' | 'ready' | 'offline';

/**
 * Whether Bender can answer right now.
 *
 * The backend is deployed separately from this app, so it can legitimately be
 * down while the page loads fine. Saying so in the header beats letting
 * someone write a request and discover it on submit.
 */
export function ModelStatus() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    let active = true;
    getHealth()
      .then(() => {
        if (active) setHealth('ready');
      })
      .catch(() => {
        if (active) setHealth('offline');
      });
    return () => {
      active = false;
    };
  }, []);

  const label =
    health === 'ready' ? 'Model ready' : health === 'offline' ? 'Backend offline' : 'Connecting…';

  return (
    <span className="flex items-center gap-2.5" role="status" aria-label="Backend status">
      <span
        aria-hidden="true"
        data-health={health}
        className={[
          'h-[7px] w-[7px] flex-none rounded-full',
          health === 'ready'
            ? 'bg-success shadow-[0_0_10px_rgb(var(--color-success)/0.6)]'
            : health === 'offline'
              ? 'bg-danger'
              : 'bg-editor-border-strong',
        ].join(' ')}
      />
      <span className="grid leading-tight">
        <strong className="text-[13px] font-semibold text-primary max-sm:hidden">{label}</strong>
        <span className="text-[11px] text-muted">
          {health === 'offline' ? 'Requests will fail' : MODEL_LABEL}
        </span>
      </span>
    </span>
  );
}
