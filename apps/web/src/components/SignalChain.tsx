import type { ChainBlock, DiffEntry } from '../api/types';
import {
  branchLabel,
  cabForBlock,
  changedBlockIds,
  groupChainByPath,
} from '../lib/signalChain';

interface SignalChainProps {
  chain: ChainBlock[];
  diff: DiffEntry[];
}

/**
 * The preset's playable blocks in signal-flow order.
 *
 * Blocks are grouped by branch and ordered by their own `position` (which is
 * deliberately not the array order). Bypassed blocks read as switched off, and
 * anything the current diff touched is flagged so a change in the review panel
 * can be traced back to the block it moved.
 */
export function SignalChain({ chain, diff }: SignalChainProps) {
  const branches = groupChainByPath(chain);
  const changed = changedBlockIds(diff);
  const showBranchHeadings = branches.length > 1;

  if (branches.length === 0) {
    return (
      <p className="text-xs leading-5 text-muted">
        This preset has no playable blocks Bender recognises.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {branches.map((branch) => (
        <div key={branch.path} className="space-y-2">
          {showBranchHeadings ? (
            <p className="eyebrow">Branch {branchLabel(branch.path)}</p>
          ) : null}
          <ol className="space-y-2">
            {branch.blocks.map((block) => (
              <BlockRow
                key={block.id}
                block={block}
                cab={cabForBlock(chain, block)}
                changed={changed.has(block.id)}
              />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

interface BlockRowProps {
  block: ChainBlock;
  cab: ChainBlock | undefined;
  changed: boolean;
}

function BlockRow({ block, cab, changed }: BlockRowProps) {
  const bypassed = !block.enabled;

  return (
    <li
      data-testid="chain-block"
      data-bypassed={bypassed}
      data-changed={changed}
      className={[
        'flex items-start gap-3 rounded-control border px-3 py-2.5 transition-colors',
        changed ? 'border-brand-500/70 bg-brand-500/5' : 'border-editor-border bg-surface-raised',
        bypassed ? 'opacity-55' : '',
      ].join(' ')}
    >
      <span
        className={['mt-1 h-2 w-2 shrink-0 rounded-full', bypassed ? 'bg-transparent ring-1 ring-inset ring-muted' : 'led'].join(' ')}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            data-testid="chain-block-label"
            className={[
              'truncate text-sm font-medium',
              bypassed ? 'text-muted line-through' : 'text-primary',
            ].join(' ')}
          >
            {block.label}
          </span>
          {changed ? (
            <span className="shrink-0 rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-300">
              Changed
            </span>
          ) : null}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <span className="rounded bg-canvas/60 px-1.5 py-0.5 uppercase tracking-wide">
            {block.role}
          </span>
          <span className="truncate font-mono">{block.model}</span>
          {cab ? <span className="truncate">· Cab: {cab.label}</span> : null}
        </div>
      </div>

      <span
        className={[
          'shrink-0 self-center text-[10px] font-semibold uppercase tracking-wide',
          bypassed ? 'text-muted' : 'text-success',
        ].join(' ')}
      >
        {bypassed ? 'Bypassed' : 'On'}
      </span>
    </li>
  );
}
