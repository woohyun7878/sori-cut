import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StarterTones } from '../StarterTones';
import { usePresetStore } from '../../store/usePresetStore';
import type { PresetView, TemplateSummary } from '../../api/types';

const getTemplates = vi.fn<() => Promise<TemplateSummary[]>>();
const createSessionFromTemplate = vi.fn<(id: string) => Promise<PresetView>>();

vi.mock('../../api/client', async (importActual) => {
  const actual = await importActual<typeof import('../../api/client')>();
  return {
    ...actual,
    getTemplates: () => getTemplates(),
    createSessionFromTemplate: (id: string) => createSessionFromTemplate(id),
  };
});

const TEMPLATES: TemplateSummary[] = [
  {
    id: 'matchless-ch2-sc',
    name: 'Boutique Clean',
    category: 'Clean',
    summary: 'Sparkly Fender-ish clean.',
    bestFor: ['clean rhythm', 'pedal platform'],
  },
  {
    id: 'crunch',
    name: 'Classic Crunch',
    category: 'Crunch',
    summary: 'Edge-of-breakup rhythm.',
    bestFor: ['classic rock rhythm'],
  },
];

function presetView(overrides: Partial<PresetView> = {}): PresetView {
  return {
    sessionId: 'sess-1',
    filename: 'crunch.hlx',
    name: 'Classic Crunch',
    device: 'Helix',
    deviceId: 2162689,
    firmware: '3.80',
    tempo: 120,
    chain: [
      {
        id: 'dsp0/block0',
        label: 'Amp Brit2204',
        model: 'HD2_AmpBrit2204',
        role: 'block',
        path: 0,
        position: 0,
        enabled: true,
        cab: null,
      },
    ],
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

afterEach(() => {
  vi.clearAllMocks();
  usePresetStore.setState({ view: null, sourceTemplateId: null, localPreview: null, conversation: [] });
});

describe('StarterTones', () => {
  it('states the empty template list honestly', async () => {
    getTemplates.mockResolvedValue([]);

    render(<StarterTones onToneLoaded={vi.fn()} />);

    expect(await screen.findByText('No starter tones yet')).toBeInTheDocument();
    expect(
      screen.getByText(/only when a real player has dialled and approved them/),
    ).toBeInTheDocument();
  });

  it('renders real templates and previews the first one', async () => {
    getTemplates.mockResolvedValue(TEMPLATES);

    render(<StarterTones onToneLoaded={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /Boutique Clean/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Classic Crunch/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Boutique Clean' })).toBeInTheDocument();
    // What the tone is for is real metadata; its chain does not exist until it loads.
    expect(screen.getByText('pedal platform')).toBeInTheDocument();
  });

  it('moves the preview when another foundation is selected', async () => {
    const user = userEvent.setup();
    getTemplates.mockResolvedValue(TEMPLATES);

    render(<StarterTones onToneLoaded={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Classic Crunch/ }));

    expect(screen.getByRole('heading', { level: 3, name: 'Classic Crunch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Classic Crunch/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Selecting is free — nothing is loaded until the player commits.
    expect(createSessionFromTemplate).not.toHaveBeenCalled();
  });

  it('opens a session and hands over once a tone is used', async () => {
    const user = userEvent.setup();
    const onToneLoaded = vi.fn();
    getTemplates.mockResolvedValue(TEMPLATES);
    createSessionFromTemplate.mockResolvedValue(presetView());

    render(<StarterTones onToneLoaded={onToneLoaded} />);

    await user.click(await screen.findByRole('button', { name: /Classic Crunch/ }));
    await user.click(screen.getByRole('button', { name: /Use this tone/ }));

    await waitFor(() => expect(onToneLoaded).toHaveBeenCalledTimes(1));
    expect(createSessionFromTemplate).toHaveBeenCalledWith('crunch');
    expect(usePresetStore.getState().sourceTemplateId).toBe('crunch');
  });

  it('does not hand over when the session could not be opened', async () => {
    const user = userEvent.setup();
    const onToneLoaded = vi.fn();
    getTemplates.mockResolvedValue(TEMPLATES);
    createSessionFromTemplate.mockRejectedValue(new Error('backend is down'));

    render(<StarterTones onToneLoaded={onToneLoaded} />);

    await user.click(await screen.findByRole('button', { name: /Use this tone/ }));

    await waitFor(() => expect(createSessionFromTemplate).toHaveBeenCalled());
    expect(onToneLoaded).not.toHaveBeenCalled();
    expect(usePresetStore.getState().view).toBeNull();
  });

  it('surfaces a load error instead of pretending there are none', async () => {
    getTemplates.mockRejectedValue(
      new Error('Bender backend is not running (start it with pnpm dev:server).'),
    );

    render(<StarterTones onToneLoaded={vi.fn()} />);

    expect(await screen.findByText(/pnpm dev:server/)).toBeInTheDocument();
  });
});
