import type { ChainBlock } from '../api/types';
import { blockKind } from '../lib/blockKind';
import { groupChainByPath } from '../lib/signalChain';

/**
 * The signal chain as a row of connected blocks.
 *
 * A compact, left-to-right read of what the preset actually is, for the moment
 * before anyone edits anything. The full per-block detail lives in the preset
 * pane; this is the shape of the tone at a glance.
 */

/** Families get a colour so an amp reads differently to a reverb at a glance. */
const KIND_COLOR: Record<string, string> = {
  Amp: '#b44e3f',
  Cab: '#927843',
  IR: '#927843',
  Preamp: '#a96243',
  Distortion: '#a96243',
  Delay: '#39767e',
  Reverb: '#39767e',
  Modulation: '#6f74a8',
  Pitch: '#8a5f9e',
  Compressor: '#55776b',
  Gate: '#55776b',
  EQ: '#748b52',
  Wah: '#748b52',
  Volume: '#55776b',
};

interface ChainPreviewProps {
  chain: ChainBlock[];
  /** Optional line under the row, e.g. device and firmware. */
  caption?: string;
}

export function ChainPreview({ chain, caption }: ChainPreviewProps) {
  // Only branch A is drawn: a preview that renders parallel paths as one row
  // would misrepresent the routing. The preset pane shows every branch.
  const blocks = groupChainByPath(chain)[0]?.blocks ?? [];

  if (blocks.length === 0) {
    return (
      <p className="text-xs leading-5 text-muted">
        This preset has no playable blocks Bender recognises.
      </p>
    );
  }

  return (
    <div className="min-w-0">
      <div className="scroll-hidden flex items-center" aria-label="Signal chain">
        {blocks.map((block, index) => (
          <ChainSegment key={block.id} block={block} first={index === 0} />
        ))}
      </div>
      {caption ? <p className="mt-2.5 text-[11px] text-muted">{caption}</p> : null}
    </div>
  );
}

function ChainSegment({ block, first }: { block: ChainBlock; first: boolean }) {
  const kind = blockKind(block);
  const color = KIND_COLOR[kind] ?? 'rgb(var(--color-border-strong))';

  return (
    <>
      {/*
        Connectors shrink before the blocks do, so a narrow column tightens the
        chain instead of squeezing the block labels onto two lines.
      */}
      {first ? null : (
        <span
          aria-hidden="true"
          className="h-px min-w-[10px] flex-[0_1_28px] bg-editor-border-strong"
        />
      )}
      <span
        data-testid="chain-preview-block"
        data-enabled={block.enabled}
        style={{ borderColor: color }}
        className={[
          'min-w-[84px] max-sm:min-w-0 rounded-control border bg-white/[0.015] px-3 py-2.5 max-sm:px-1.5 max-sm:py-2',
          'text-center font-mono text-[9px] uppercase tracking-[0.05em] text-secondary',
          block.enabled ? '' : 'opacity-50',
        ].join(' ')}
        title={`${block.label} — ${kind}${block.enabled ? '' : ' (bypassed)'}`}
      >
        {block.label}
      </span>
    </>
  );
}
