import { useState } from 'react';
import type { ChainBlock, DiffEntry } from '../api/types';
import { blockKind } from '../lib/blockKind';
import { formatDiffValue, groupDiffByBlock } from '../lib/diff';
import { branchLabel, cabForBlock, groupChainByPath } from '../lib/signalChain';

interface SignalChainProps {
  chain: ChainBlock[];
  diff: DiffEntry[];
}

/**
 * The preset's playable blocks in signal-flow order.
 *
 * Blocks are grouped by branch and ordered by their own `position` (which is
 * deliberately not the array order). Bypassed blocks read as switched off, and
 * anything the current diff touched shows its before/after inline — a changed
 * parameter is the most useful thing on the page, so it stays legible without
 * expanding the block.
 */
export function SignalChain({ chain, diff }: SignalChainProps) {
  const branches = groupChainByPath(chain);
  const changes = new Map(groupDiffByBlock(diff).map((group) => [group.id, group.changes]));
  const showBranchHeadings = branches.length > 1;

  if (branches.length === 0) {
    return (
      <p className="mt-3.5 text-xs leading-[1.55] text-muted">
        This preset has no playable blocks Bender recognises.
      </p>
    );
  }

  return (
    <div className="mt-3.5 space-y-4">
      {branches.map((branch) => (
        <div key={branch.path}>
          {showBranchHeadings ? (
            <p className="eyebrow mb-1">Branch {branchLabel(branch.path)}</p>
          ) : null}
          <ul>
            {branch.blocks.map((block, index) => (
              <BlockItem
                key={block.id}
                block={block}
                index={index}
                cab={cabForBlock(chain, block)}
                changes={changes.get(block.id) ?? []}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

interface BlockItemProps {
  block: ChainBlock;
  index: number;
  cab: ChainBlock | undefined;
  changes: DiffEntry[];
}

function BlockItem({ block, index, cab, changes }: BlockItemProps) {
  const [expanded, setExpanded] = useState(false);
  const kind = blockKind(block);
  const bypassed = !block.enabled;

  return (
    <li data-testid="chain-block" data-enabled={block.enabled} data-changed={changes.length > 0}>
      <div
        className={[
          'grid grid-cols-[22px_10px_minmax(0,1fr)_auto_auto] items-center gap-2.5 py-2.5',
          index === 0 ? '' : 'border-t border-editor-border',
        ].join(' ')}
      >
        <span className="font-mono text-[10px] text-muted">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span
          aria-hidden="true"
          className={[
            'h-[7px] w-[7px] rounded-full',
            bypassed ? 'bg-editor-border-strong' : 'bg-brand-500',
          ].join(' ')}
        />
        <span
          data-testid="chain-block-label"
          className={[
            'min-w-0 truncate text-[13px]',
            bypassed ? 'text-muted' : 'text-primary',
          ].join(' ')}
        >
          {block.label}
        </span>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">
          {kind}
          {bypassed ? ' · bypassed' : ''}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${block.label} details`}
          className="grid h-6 w-6 place-items-center rounded-control text-muted transition-colors hover:bg-white/[0.05] hover:text-primary"
        >
          <span aria-hidden="true" className="tracking-[1px]">
            {expanded ? '−' : '…'}
          </span>
        </button>
      </div>

      {/*
        A changed parameter shows without expanding; the detail behind the
        toggle is the block's identity, which is what tells you whether the
        right thing moved.
      */}
      {changes.length > 0 ? (
        <ul className="mb-2.5 ml-[42px] flex flex-wrap gap-1.5">
          {changes.map((change) => (
            <li
              key={change.parameter}
              data-testid="block-diff"
              className="inline-flex items-center gap-1.5 rounded-control bg-brand-500/[0.12] px-2.5 py-1 font-mono text-[10px] text-brand-300"
            >
              {change.parameter}
              <s className="text-muted decoration-[rgb(var(--color-text-muted))]">
                {formatDiffValue(change.before)}
              </s>
              <span aria-hidden="true">→</span>
              <span className="sr-only">changed to</span>
              {formatDiffValue(change.after)}
            </li>
          ))}
        </ul>
      ) : null}

      {expanded ? (
        <ul className="mb-2.5 ml-[42px] flex flex-wrap gap-1.5">
          <Detail label="Model" value={block.model} />
          {cab ? <Detail label="Cab" value={cab.label} /> : null}
          {block.path !== undefined ? (
            <Detail label="Branch" value={branchLabel(block.path)} />
          ) : null}
          <Detail label="State" value={bypassed ? 'Bypassed' : 'On'} />
        </ul>
      ) : null}
    </li>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <li className="rounded-control bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] text-secondary">
      <span className="text-muted">{label} </span>
      {value}
    </li>
  );
}
