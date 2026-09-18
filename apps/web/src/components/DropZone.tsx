import { useRef, useState, type DragEvent } from 'react';
import { usePresetStore } from '../store/usePresetStore';

const ACCEPTED_PRESET_TYPES = '.hlx,application/json';

/**
 * Mirrors `maxPresetBytes` in apps/server/src/http/routes.ts. Checking it here
 * turns a 2 MB round trip that ends in a 413 into an instant, local answer;
 * the server still enforces it, this is only the fast path.
 */
const MAX_PRESET_BYTES = 2048 * 1024;

interface UploadNotice {
  title: string;
  detail: string;
}

const REJECTIONS: Record<'type' | 'size', UploadNotice> = {
  type: {
    title: 'That is not a .hlx file',
    detail: 'Bender reads Line 6 Helix presets. Export one from HX Edit and try again.',
  },
  size: {
    title: 'That preset is too large',
    detail:
      'Presets must be under 2048 KB. A Helix preset is normally a few KB, so this is probably a bundle.',
  },
};

/**
 * Bender's preset intake.
 *
 * It lives inside the preset pane rather than behind a separate intake screen,
 * so the whole workflow — ask, inspect, download — is visible before anyone
 * commits a file. Obvious rejections are answered locally; the store parses
 * the file with `@bender/helix` for instant confirmation, then opens a
 * server-side session that becomes the source of truth.
 */
export function DropZone() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadPreset = usePresetStore((state) => state.loadPreset);
  const uploadError = usePresetStore((state) => state.uploadError);
  const isUploading = usePresetStore((state) => state.isUploading);
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [rejection, setRejection] = useState<UploadNotice | null>(null);

  const handleFileSelection = async (file: File | null) => {
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.hlx')) {
      setRejection(REJECTIONS.type);
      return;
    }
    if (file.size > MAX_PRESET_BYTES) {
      setRejection(REJECTIONS.size);
      return;
    }

    setRejection(null);
    setIsReading(true);
    try {
      const text = await file.text();
      await loadPreset(file.name, text);
    } finally {
      setIsReading(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    await handleFileSelection(event.dataTransfer.files.item(0));
  };

  const busy = isReading || isUploading;
  const notice =
    rejection ??
    (uploadError ? { title: 'Bender could not open that preset', detail: uploadError } : null);

  return (
    <div
      onDragEnter={() => setIsDragging(true)}
      onDragLeave={() => setIsDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDrop={(event) => void handleDrop(event)}
      className="mt-3.5"
      aria-busy={busy}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_PRESET_TYPES}
        className="hidden"
        aria-label="Choose a Helix .hlx preset file"
        onChange={(event) => {
          void handleFileSelection(event.target.files?.item(0) ?? null);
          event.currentTarget.value = '';
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className={[
          'flex w-full items-center gap-3 rounded-control border border-dashed px-4 py-4 text-left transition-colors',
          'hover:border-brand-500 hover:bg-brand-500/[0.07] disabled:cursor-not-allowed disabled:opacity-60',
          isDragging ? 'border-brand-500 bg-brand-500/[0.07]' : 'border-editor-border-strong bg-white/[0.015]',
        ].join(' ')}
      >
        <span className="flex-none text-brand-500" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 16V4M12 4L8 8M12 4l4 4M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span>
          <strong className="block text-sm font-semibold text-primary">
            {busy ? 'Opening your preset…' : 'Drop your .hlx preset'}
          </strong>
          <span className="mt-0.5 block text-xs text-muted">or browse for a file</span>
        </span>
      </button>

      <p className="mt-2.5 font-mono text-[10px] tracking-[0.04em] text-muted">
        .hlx · max 2048 KB · your original stays unchanged
      </p>

      <div role="status" aria-live="polite">
        {notice ? (
          <div className="mt-3.5 flex gap-3 rounded-control border border-danger/40 bg-danger/[0.09] px-4 py-3.5">
            <span aria-hidden="true" className="flex-none leading-snug text-danger">
              !
            </span>
            <div className="min-w-0">
              <strong className="block text-[13px] font-semibold text-primary">
                {notice.title}
              </strong>
              <p className="mt-1.5 text-[13px] leading-normal text-secondary">{notice.detail}</p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="btn-pill"
                >
                  Choose another file
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
