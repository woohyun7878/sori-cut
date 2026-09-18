import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  block({ id: 'dsp0/block2', label: 'Volume Pedal', model: 'HD2_VolPanVol', position: 7 }),
  block({
    id: 'dsp0/block0',
    label: 'Compulsive Drive',
    model: 'HD2_DistCompulsiveDrive',
    position: 2,
    enabled: false,
  }),
  block({
    id: 'dsp0/block1',
    label: 'Amp Brit2204',
    model: 'HD2_AmpBrit2204',
    position: 3,
    cab: 'cab0',
  }),
  block({ id: 'dsp0/cab0', label: 'Cab 4x12', model: 'HD2_Cab4x121960T75', role: 'cab', position: 0 }),
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
    expect(bypassed).toHaveAttribute('data-enabled', 'false');
    expect(within(bypassed as HTMLElement).getByText(/bypassed/i)).toBeInTheDocument();
  });

  it('names the block family from its Helix model id', () => {
    render(<SignalChain chain={singlePath} diff={[]} />);

    const amp = screen.getByText('Amp Brit2204').closest('[data-testid="chain-block"]');
    expect(within(amp as HTMLElement).getByText('Amp')).toBeInTheDocument();
  });

  it('shows a changed parameter before and after without expanding the block', () => {
    const diff: DiffEntry[] = [
      {
        dsp: 'dsp0',
        slot: 'block1',
        label: 'Amp Brit2204',
        parameter: 'Master',
        before: 0.36,
        after: 0.48,
      },
    ];

    render(<SignalChain chain={singlePath} diff={diff} />);

    const amp = screen.getByText('Amp Brit2204').closest('[data-testid="chain-block"]');
    expect(amp).toHaveAttribute('data-changed', 'true');

    const change = within(amp as HTMLElement).getByTestId('block-diff');
    expect(change).toHaveTextContent('Master');
    expect(change).toHaveTextContent('0.36');
    expect(change).toHaveTextContent('0.48');
  });

  it('reveals the paired cab and model behind the block toggle', async () => {
    const user = userEvent.setup();
    render(<SignalChain chain={singlePath} diff={[]} />);

    expect(screen.queryByText(/Cab 4x12/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show Amp Brit2204 details' }));

    const amp = screen.getByText('Amp Brit2204').closest('[data-testid="chain-block"]');
    expect(within(amp as HTMLElement).getByText(/Cab 4x12/)).toBeInTheDocument();
    expect(within(amp as HTMLElement).getByText(/HD2_AmpBrit2204/)).toBeInTheDocument();
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

  it('says so when the preset has no playable blocks', () => {
    render(<SignalChain chain={[]} diff={[]} />);
    expect(screen.getByText(/no playable blocks Bender recognises/i)).toBeInTheDocument();
  });
});
