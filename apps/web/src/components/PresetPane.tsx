import { usePresetStore } from '../store/usePresetStore';
import { ChangesPanel } from './ChangesPanel';
import { DropZone } from './DropZone';
import { SignalChain } from './SignalChain';

/**
 * The state of the preset Bender is working on.
 *
 * One pane with hairline-separated groups rather than three stacked cards:
 * what is loaded, what is in it, and what is about to change. Every group
 * renders before a preset exists so the whole workflow is visible up front —
 * nobody has to commit a file to find out what happens next.
 */
export function PresetPane() {
  const view = usePresetStore((state) => state.view);
  const localPreview = usePresetStore((state) => state.localPreview);
  const isUploading = usePresetStore((state) => state.isUploading);
  const clearPreset = usePresetStore((state) => state.clearPreset);

  const loaded = view !== null || localPreview !== null;
  const blockCount = view
    ? view.chain.filter((block) => block.role === 'block').length
    : (localPreview?.blockCount ?? 0);

  return (
    <aside
      aria-label="Preset state"
      data-preset={loaded ? 'loaded' : 'empty'}
      className={[
        'min-w-0 divide-y divide-editor-border rounded-editor border border-editor-border bg-surface',
        // Until a preset is loaded the drop target is the only useful control,
        // so it leads on a narrow screen. Once loaded the conversation takes
        // the top again.
        loaded ? '' : 'max-lg:order-first',
      ].join(' ')}
    >
      <section className="px-5 py-[18px]" aria-labelledby="loaded-preset-label">
        <div className="flex items-center justify-between gap-4">
          <p className="eyebrow-lit" id="loaded-preset-label">
            Loaded preset
          </p>
          {loaded ? (
            <button type="button" onClick={clearPreset} className="btn-pill">
              Replace preset
            </button>
          ) : null}
        </div>

        {loaded ? (
          <div className="mt-3.5 flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-[34px] w-[34px] flex-none place-items-center rounded-control border border-editor-border-strong text-muted"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                />
                <path d="M14 3v5h5" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2.5">
                <strong className="min-w-0 truncate text-sm font-semibold text-primary">
                  {view?.name ?? localPreview?.name ?? localPreview?.fileName}
                </strong>
                {isUploading ? (
                  <span className="pill pill-idle">Opening</span>
                ) : view?.modified ? (
                  <span className="pill pill-changed">Modified</span>
                ) : (
                  <span className="pill pill-ok">Loaded</span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">
                {metaLine({
                  device: view?.device ?? localPreview?.deviceName,
                  firmware: view?.firmware ?? localPreview?.firmware,
                  blockCount,
                  sizeBytes: localPreview?.sizeBytes,
                  fileName: view?.filename ?? localPreview?.fileName,
                })}
              </span>
            </span>
          </div>
        ) : (
          <DropZone />
        )}
      </section>

      <section className="px-5 py-[18px]" aria-labelledby="blocks-label">
        <div className="flex items-center justify-between gap-4">
          <p className="eyebrow-lit" id="blocks-label">
            Blocks &amp; routing
          </p>
          <p className="eyebrow">
            {blockCount > 0 ? `Signal chain · ${blockCount}` : 'Signal chain'}
          </p>
        </div>

        {view ? (
          <SignalChain chain={view.chain} diff={view.diff} />
        ) : (
          <p className="mt-3.5 text-xs leading-[1.55] text-muted">
            {isUploading
              ? 'Reading the signal chain…'
              : 'Your signal chain appears here block by block, with what Bender changed on each one.'}
          </p>
        )}
      </section>

      <ChangesPanel />
    </aside>
  );
}

interface MetaLineInput {
  device?: string | null;
  firmware?: string | null;
  blockCount: number;
  sizeBytes?: number;
  fileName?: string | null;
}

/** Device, firmware, block count and size on one line — omitting what is unknown. */
function metaLine({ device, firmware, blockCount, sizeBytes, fileName }: MetaLineInput): string {
  const parts: string[] = [];
  if (device) parts.push(device);
  if (firmware) parts.push(`firmware ${firmware}`);
  if (blockCount > 0) parts.push(`${blockCount} block${blockCount === 1 ? '' : 's'}`);
  if (sizeBytes !== undefined) parts.push(`${(sizeBytes / 1024).toFixed(1)} KB`);
  if (parts.length === 0 && fileName) parts.push(fileName);
  return parts.join(' · ');
}
