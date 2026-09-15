import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ChangesPanel } from '../ChangesPanel';
import { usePresetStore } from '../../store/usePresetStore';
import type { PresetView } from '../../api/types';

function view(overrides: Partial<PresetView> = {}): PresetView {
  return {
    sessionId: 'sess-1',
    filename: 'possum.hlx',
    name: 'Possum',
    device: 'HX Stomp',
    deviceId: 2162694,
    firmware: '3.11',
    tempo: 120,
    chain: [],
    snapshots: [],
    activeSnapshot: 0,
    modified: false,
    canUndo: false,
    canRedo: false,
    diff: [],
    edits: [],
    ...overrides,
  };
}

function seed(overrides: Partial<PresetView>) {
  const next = view(overrides);
  usePresetStore.setState({ view: next, canUndo: next.canUndo, canRedo: next.canRedo });
}

afterEach(() => {
  usePresetStore.setState({ view: null, canUndo: false, canRedo: false });
});

describe('ChangesPanel', () => {
  it('renders the before/after diff grouped by block', () => {
    seed({
      modified: true,
      diff: [
        { dsp: 'dsp0', slot: 'block1', label: 'Amp Brit2204', parameter: 'Master', before: 0.36, after: 0.48 },
        { dsp: 'dsp0', slot: 'block1', label: 'Amp Brit2204', parameter: 'Bass', before: 0.4, after: 0.5 },
        { dsp: 'dsp0', slot: 'block0', label: 'Compulsive Drive', parameter: 'Gain', before: 0.66, after: 0.7 },
      ],
    });

    render(<ChangesPanel />);

    // Two block groups, the amp listed once with both of its parameters.
    const ampGroup = screen.getByText('Amp Brit2204').closest('div');
    expect(within(ampGroup as HTMLElement).getByText('Master')).toBeInTheDocument();
    expect(within(ampGroup as HTMLElement).getByText('Bass')).toBeInTheDocument();
    expect(screen.getByText('Compulsive Drive')).toBeInTheDocument();

    // Before/after values are shown.
    expect(screen.getByText('0.36')).toBeInTheDocument();
    expect(screen.getByText('0.48')).toBeInTheDocument();
  });

  it('shows the modified state and always offers a download', () => {
    seed({ modified: true, diff: [] });

    render(<ChangesPanel />);

    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download \.hlx/i })).toBeInTheDocument();
  });

  it('reports an unmodified preset honestly', () => {
    seed({ modified: false, diff: [] });

    render(<ChangesPanel />);

    expect(screen.getByText('Unchanged')).toBeInTheDocument();
    expect(screen.getByText(/No changes yet/)).toBeInTheDocument();
    // Revert-all is meaningless with nothing to revert.
    expect(screen.getByRole('button', { name: 'Revert all' })).toBeDisabled();
  });

  it('lists the edit audit trail when present', () => {
    seed({
      modified: true,
      edits: [
        {
          sequence: 1,
          tool: 'set_parameter',
          summary: 'Amp Brit2204: Master 0.36 -> 0.48',
          target: { dsp: 'dsp0', slot: 'block1', label: 'Amp Brit2204' },
          parameter: 'Master',
          before: 0.36,
          after: 0.48,
        },
      ],
    });

    render(<ChangesPanel />);

    expect(screen.getByText(/Edit history \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Amp Brit2204: Master 0.36 -> 0.48/)).toBeInTheDocument();
  });
});
