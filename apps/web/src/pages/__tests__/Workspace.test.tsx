import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Workspace } from '../Workspace';
import { usePresetStore } from '../../store/usePresetStore';
import type { MessageResponse, PresetView, TemplateSummary } from '../../api/types';

const getTemplates = vi.fn<() => Promise<TemplateSummary[]>>();
const getHealth = vi.fn<() => Promise<{ status: string; activeSessions: number }>>();
const sendMessage = vi.fn<(id: string, message: string) => Promise<MessageResponse>>();

vi.mock('../../api/client', async (importActual) => {
  const actual = await importActual<typeof import('../../api/client')>();
  return {
    ...actual,
    getTemplates: () => getTemplates(),
    getHealth: () => getHealth(),
    sendMessage: (id: string, message: string) => sendMessage(id, message),
  };
});

function presetView(overrides: Partial<PresetView> = {}): PresetView {
  return {
    sessionId: 'sess-1',
    filename: 'possum.hlx',
    name: 'Possum',
    device: 'HX Stomp',
    deviceId: 2162694,
    firmware: '3.11',
    tempo: 120,
    chain: [
      {
        id: 'dsp0/block1',
        label: 'Amp Brit2204',
        model: 'HD2_AmpBrit2204',
        role: 'block',
        path: 0,
        position: 1,
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

function loaded(view: PresetView = presetView()) {
  usePresetStore.setState({
    view,
    canUndo: view.canUndo,
    canRedo: view.canRedo,
    localPreview: {
      fileName: view.filename,
      name: view.name ?? undefined,
      deviceName: view.device ?? undefined,
      firmware: view.firmware ?? undefined,
      blockCount: 1,
      sizeBytes: 3712,
    },
  });
}

function renderWorkspace(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  usePresetStore.setState({
    view: null,
    localPreview: null,
    uploadError: null,
    isUploading: false,
    isSending: false,
    sourceTemplateId: null,
    conversation: [],
    canUndo: false,
    canRedo: false,
  });
});

describe('Workspace', () => {
  it('opens on the starter tones and switches panels on demand', async () => {
    const user = userEvent.setup();
    getTemplates.mockResolvedValue([]);
    getHealth.mockResolvedValue({ status: 'ok', activeSessions: 0 });

    renderWorkspace();

    expect(screen.getByRole('tab', { name: /Start with a tone/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('No starter tones yet')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Upload a preset/ }));

    expect(screen.getByRole('tab', { name: /Upload a preset/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Describe a tone change' })).toBeInTheDocument();
  });

  it('honours ?mode=upload so the workspace can be linked to directly', () => {
    getHealth.mockResolvedValue({ status: 'ok', activeSessions: 0 });

    renderWorkspace('/?mode=upload');

    expect(screen.getByRole('tab', { name: /Upload a preset/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('shows the whole workflow before a preset is loaded', () => {
    getHealth.mockResolvedValue({ status: 'ok', activeSessions: 0 });

    renderWorkspace('/?mode=upload');

    // The drop target is in the preset pane, not behind a separate intake screen.
    expect(screen.getByLabelText('Choose a Helix .hlx preset file')).toBeInTheDocument();
    expect(screen.getByText(/signal chain appears here block by block/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download \.hlx/ })).toBeDisabled();
    // Nothing to ask about yet.
    expect(screen.getByLabelText('Describe a tone change')).toBeDisabled();
  });

  it('identifies the loaded preset and its chain', () => {
    getHealth.mockResolvedValue({ status: 'ok', activeSessions: 0 });
    loaded();

    renderWorkspace('/?mode=upload');

    expect(screen.getByText('Possum')).toBeInTheDocument();
    expect(screen.getByText(/HX Stomp · firmware 3\.11 · 1 block/)).toBeInTheDocument();
    expect(screen.getByTestId('chain-block-label')).toHaveTextContent('Amp Brit2204');
    expect(screen.getByRole('button', { name: 'Replace preset' })).toBeInTheDocument();
  });

  it('sends a request and shows the reply, the steps and the change', async () => {
    const user = userEvent.setup();
    getHealth.mockResolvedValue({ status: 'ok', activeSessions: 0 });
    loaded();

    const edited = presetView({
      modified: true,
      canUndo: true,
      diff: [
        {
          dsp: 'dsp0',
          slot: 'block1',
          label: 'Amp Brit2204',
          parameter: 'Master',
          before: 0.36,
          after: 0.48,
        },
      ],
    });

    sendMessage.mockResolvedValue({
      reply: 'Pushed the master up for more push.',
      activity: [
        { kind: 'tool', name: 'inspect_signal_chain', ok: true, durationMs: 12 },
        {
          kind: 'tool',
          name: 'set_parameter',
          ok: true,
          detail: 'Amp Brit2204: Master 0.36 -> 0.48',
          durationMs: 9,
        },
      ],
      toolCalls: [
        { name: 'inspect_signal_chain', ok: true, durationMs: 12, error: null, warnings: [] },
        { name: 'set_parameter', ok: true, durationMs: 9, error: null, warnings: [] },
      ],
      truncated: false,
      latencyMs: 4200,
      modelRequestIds: ['req-1'],
      preset: edited,
    });

    renderWorkspace('/?mode=upload');

    await user.type(screen.getByLabelText('Describe a tone change'), 'more gain');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Pushed the master up for more push.')).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith('sess-1', 'more gain');

    // The tool calls are shown as completed steps, not raw JSON.
    expect(screen.getByText('Inspected the signal chain')).toBeInTheDocument();
    expect(screen.getByText(/Amp Brit2204: Master 0.36 → 0.48/)).toBeInTheDocument();

    // And the change lands in review, with what it started from.
    expect(screen.getByText('Amp Brit2204 · Master')).toBeInTheDocument();
    expect(screen.getByText('1 changed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('offers a retry when a request fails, without losing the request', async () => {
    const user = userEvent.setup();
    getHealth.mockResolvedValue({ status: 'ok', activeSessions: 0 });
    loaded();

    sendMessage.mockRejectedValueOnce(new Error('Could not reach the Bender backend.'));

    renderWorkspace('/?mode=upload');

    await user.type(screen.getByLabelText('Describe a tone change'), 'more gain');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Bender hit a problem')).toBeInTheDocument();

    sendMessage.mockResolvedValueOnce({
      reply: 'Done.',
      activity: [],
      toolCalls: [],
      truncated: false,
      latencyMs: 1000,
      modelRequestIds: [],
      preset: presetView(),
    });

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith('sess-1', 'more gain');
    expect(await screen.findByText('Done.')).toBeInTheDocument();
  });

  it('says so when the backend cannot be reached', async () => {
    getTemplates.mockResolvedValue([]);
    getHealth.mockRejectedValue(new Error('offline'));

    renderWorkspace();

    const status = await screen.findByRole('status', { name: 'Backend status' });
    expect(within(status).getByText('Requests will fail')).toBeInTheDocument();
  });
});
