import { useRef, useState, type DragEvent } from 'react';
import { usePresetStore } from '../store/usePresetStore';

const ACCEPTED_PRESET_TYPES = '.hlx,application/json';

/**
 * Bender's preset intake.
 *
 * Accepts a Line 6 Helix `.hlx` file, reads it as text and hands it to the
 * preset store, which parses it with `@bender/helix`. On success the store
 * exposes the preset's real metadata (name, device, block count), which this
 * component surfaces so the upload is honestly confirmed rather than mocked.
 */
export function DropZone() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadPreset = usePresetStore((state) => state.loadPreset);
  const clearPreset = usePresetStore((state) => state.clearPreset);
  const preset = usePresetStore((state) => state.preset);
  const error = usePresetStore((state) => state.error);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleFileSelection = async (file: File | null) => {
    if (!file) {
      return;
    }

    setIsLoading(true);
    try {
      const text = await file.text();
      loadPreset(file.name, text);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    await handleFileSelection(event.dataTransfer.files.item(0));
  };

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
      aria-busy={isLoading}
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
        disabled={isLoading}
        className="btn-primary mt-6"
      >
        {isLoading ? 'Reading…' : 'Browse files'}
      </button>

      <div role="status" aria-live="polite">
        {error ? (
          <p className="mx-auto mt-6 max-w-md rounded-control border border-danger/40 bg-danger/10 p-3 text-left text-xs text-danger">
            {error}
          </p>
        ) : null}

        {preset ? (
          <div className="mx-auto mt-6 max-w-md rack-panel p-4 text-left">
            <div className="flex items-center gap-2">
              <span className="led" aria-hidden="true" />
              <p className="truncate text-sm font-medium text-primary">
                {preset.name ?? preset.fileName}
              </p>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted">Device</dt>
              <dd className="text-secondary">{preset.deviceName ?? 'Unknown'}</dd>
              <dt className="text-muted">Firmware</dt>
              <dd className="text-secondary">{preset.firmware ?? '—'}</dd>
              <dt className="text-muted">Blocks</dt>
              <dd className="text-secondary">{preset.blockCount}</dd>
              <dt className="text-muted">File</dt>
              <dd className="truncate text-secondary">{preset.fileName}</dd>
            </dl>
            <button
              type="button"
              onClick={clearPreset}
              className="btn-secondary mt-4 w-full"
            >
              Remove preset
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
