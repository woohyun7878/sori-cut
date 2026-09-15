import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SignalChain } from '../SignalChain';
import type { ChainBlock, DiffEntry } from '../../api/types';

function block(overrides: Partial<ChainBlock> & Pick<ChainBlock, 'id'>): ChainBlock {
  return {
    label: 'Block',
    model: 'HD2_Model',
    role: 'block',
    path: 0,
    position: 0,
    enabled: true,
    cab: null,
    ...overrides,
  };
}

const singlePath: ChainBlock[] = [
  block({ id: 'dsp0/block2', label: 'Volume Pedal', position: 7 }),
  block({ id: 'dsp0/block0', label: 'Compulsive Drive', position: 2, enabled: false }),
  block({ id: 'dsp0/block1', label: 'Amp Brit2204', position: 3, cab: 'cab0' }),
  block({ id: 'dsp0/cab0', label: 'Cab 4x12', role: 'cab', position: 0 }),
];

describe('SignalChain', () => {
  it('renders blocks in position order, not array order', () => {
    render(<SignalChain chain={singlePath} diff={[]} />);

    const labels = screen.getAllByTestId('chain-block-label').map((el) => el.textContent);
    expect(labels).toEqual(['Compulsive Drive', 'Amp Brit2204', 'Volume Pedal']);
  });

  it('marks a bypassed block distinctly', () => {
    render(<SignalChain chain={singlePath} diff={[]} />);

    const bypassed = screen.getByText('Compulsive Drive').closest('[data-testid="chain-block"]');
    expect(bypassed).toHaveAttribute('data-bypassed', 'true');
    expect(within(bypassed as HTMLElement).getByText('Bypassed')).toBeInTheDocument();
  });

  it('flags blocks touched by the current diff', () => {
    const diff: DiffEntry[] = [
      { dsp: 'dsp0', slot: 'block1', label: 'Amp Brit2204', parameter: 'Master', before: 0.36, after: 0.48 },
    ];

    render(<SignalChain chain={singlePath} diff={diff} />);

    const amp = screen.getByText('Amp Brit2204').closest('[data-testid="chain-block"]');
    expect(amp).toHaveAttribute('data-changed', 'true');
    expect(within(amp as HTMLElement).getByText('Changed')).toBeInTheDocument();
  });

  it('shows the paired cab against its amp', () => {
    render(<SignalChain chain={singlePath} diff={[]} />);
    expect(screen.getByText(/Cab: Cab 4x12/)).toBeInTheDocument();
  });

  it('omits branch headings when there is a single path', () => {
    render(<SignalChain chain={singlePath} diff={[]} />);
    expect(screen.queryByText('Branch A')).not.toBeInTheDocument();
  });

  it('shows branch headings when there are two paths', () => {
    const twoPaths: ChainBlock[] = [
      block({ id: 'dsp0/block0', label: 'A block', path: 0, position: 1 }),
      block({ id: 'dsp0/block1', label: 'B block', path: 1, position: 1 }),
    ];

    render(<SignalChain chain={twoPaths} diff={[]} />);

    expect(screen.getByText('Branch A')).toBeInTheDocument();
    expect(screen.getByText('Branch B')).toBeInTheDocument();
  });
});
