import { useRef, useState, type DragEvent } from 'react';
import { usePresetStore } from '../store/usePresetStore';

const ACCEPTED_PRESET_TYPES = '.hlx,application/json';

/**
 * Bender's preset intake.
 *
 * Accepts a Line 6 Helix `.hlx` file and reads it as text. The store parses it
 * locally with `@bender/helix` for instant confirmation, then opens a
 * server-side session that becomes the source of truth. This component
 * surfaces whichever metadata is most authoritative — the server view once it
 * arrives, the local parse until then.
 */
export function DropZone() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadPreset = usePresetStore((state) => state.loadPreset);
  const clearPreset = usePresetStore((state) => state.clearPreset);
  const localPreview = usePresetStore((state) => state.localPreview);
  const view = usePresetStore((state) => state.view);
  const uploadError = usePresetStore((state) => state.uploadError);
  const isUploading = usePresetStore((state) => state.isUploading);
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);

  const handleFileSelection = async (file: File | null) => {
    if (!file) return;

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

  const name = view?.name ?? localPreview?.name ?? localPreview?.fileName ?? null;
  const deviceName = view?.device ?? localPreview?.deviceName ?? 'Unknown';
  const firmware = view?.firmware ?? localPreview?.firmware ?? '—';
  const blockCount = view
    ? view.chain.filter((block) => block.role === 'block').length
    : (localPreview?.blockCount ?? 0);
  const fileName = view?.filename ?? localPreview?.fileName ?? '';
  const busy = isReading || isUploading;

  return (
    <div
      onDragEnter={() => setIsDragging(true)}
      onDragLeave={() => setIsDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDrop={(event) => void handleDrop(event)}
      role="group"
      aria-label="Helix preset upload"
      aria-busy={busy}
      className={[
        'rounded-editor border-2 border-dashed bg-surface/60 p-8 text-center transition-colors',
        isDragging
          ? 'border-brand-500 bg-brand-500/5'
          : 'border-editor-border hover:border-brand-600/60',
      ].join(' ')}
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

      <div
        className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-panel border border-editor-border bg-surface-raised text-secondary"
        aria-hidden="true"
      >
        <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 16V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"
          />
        </svg>
      </div>

      <h3 className="text-lg font-semibold text-primary">Drop your .hlx preset here</h3>
      <p className="mt-1 text-sm text-secondary">or click to browse</p>
      <p className="mt-4 text-xs text-muted">Line 6 Helix preset · .hlx</p>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="btn-primary mt-6"
      >
        {isReading ? 'Reading…' : isUploading ? 'Opening…' : 'Browse files'}
      </button>

      <div role="status" aria-live="polite">
        {uploadError ? (
          <p className="mx-auto mt-6 max-w-md rounded-control border border-danger/40 bg-danger/10 p-3 text-left text-xs text-danger">
            {uploadError}
          </p>
        ) : null}

        {localPreview ? (
          <div className="mx-auto mt-6 max-w-md rack-panel p-4 text-left">
            <div className="flex items-center gap-2">
              <span className="led" aria-hidden="true" />
              <p className="truncate text-sm font-medium text-primary">{name}</p>
              {isUploading ? (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">
                  Opening…
                </span>
              ) : view?.modified ? (
                <span className="ml-auto rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-300">
                  Modified
                </span>
              ) : null}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted">Device</dt>
              <dd className="text-secondary">{deviceName}</dd>
              <dt className="text-muted">Firmware</dt>
              <dd className="text-secondary">{firmware}</dd>
              <dt className="text-muted">Blocks</dt>
              <dd className="text-secondary">{blockCount}</dd>
              <dt className="text-muted">File</dt>
              <dd className="truncate text-secondary">{fileName}</dd>
            </dl>
            <button type="button" onClick={clearPreset} className="btn-secondary mt-4 w-full">
              Remove preset
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
