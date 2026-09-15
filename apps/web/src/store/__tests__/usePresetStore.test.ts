import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../api/client';
import { usePresetStore } from '../usePresetStore';
import type { MessageResponse, PresetView } from '../../api/types';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    createSession: vi.fn(),
    createSessionFromTemplate: vi.fn(),
    sendMessage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    reset: vi.fn(),
    deleteSession: vi.fn(),
    fetchPresetBlob: vi.fn(),
  };
});

vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }));

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

const initialState = usePresetStore.getState();

beforeEach(() => {
  usePresetStore.setState({
    localPreview: null,
    uploadError: null,
    isUploading: false,
    view: null,
    conversation: [],
    isSending: false,
    isMutating: false,
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadPreset', () => {
  it('rejects a file that is not a Helix preset before any network call', async () => {
    await initialState.loadPreset('junk.hlx', 'this is not json');

    expect(usePresetStore.getState().uploadError).toMatch(/could not be read as a Helix preset/);
    expect(usePresetStore.getState().view).toBeNull();
    expect(vi.mocked(client.createSession)).not.toHaveBeenCalled();
  });

  it('parses locally then adopts the server view as the source of truth', async () => {
    vi.mocked(client.createSession).mockResolvedValue(view({ name: 'Possum' }));

    await initialState.loadPreset('possum.hlx', '{}');

    expect(vi.mocked(client.createSession)).toHaveBeenCalledWith('{}', 'possum.hlx');
    const state = usePresetStore.getState();
    expect(state.view?.name).toBe('Possum');
    expect(state.uploadError).toBeNull();
    expect(state.localPreview?.fileName).toBe('possum.hlx');
  });

  it('shows the server message when the upload is rejected', async () => {
    vi.mocked(client.createSession).mockRejectedValue(
      new client.ApiError('This file could not be read as a Helix preset.', {
        kind: 'http',
        status: 422,
      }),
    );

    await initialState.loadPreset('possum.hlx', '{}');

    expect(usePresetStore.getState().uploadError).toContain('could not be read');
    expect(usePresetStore.getState().view).toBeNull();
  });
});

describe('sendMessage', () => {
  function messageResponse(overrides: Partial<MessageResponse> = {}): MessageResponse {
    return {
      reply: 'Bumped the master a touch.',
      activity: [
        { kind: 'tool', name: 'set_parameter', ok: true, detail: 'Amp: Master 0.36 -> 0.48', durationMs: 5 },
      ],
      toolCalls: [{ name: 'set_parameter', ok: true, durationMs: 5, error: null, warnings: [] }],
      truncated: false,
      latencyMs: 4200,
      modelRequestIds: ['req-1'],
      preset: view({ modified: true, canUndo: true }),
      ...overrides,
    };
  }

  it('records the exchange and adopts the returned preset view', async () => {
    usePresetStore.setState({ view: view() });
    vi.mocked(client.sendMessage).mockResolvedValue(messageResponse());

    await initialState.sendMessage('make it louder');

    const state = usePresetStore.getState();
    expect(state.conversation.map((t) => t.role)).toEqual(['user', 'bender']);
    expect(state.view?.modified).toBe(true);
    expect(state.canUndo).toBe(true);
    expect(state.isSending).toBe(false);
  });

  it('records a failed tool call as a visible error turn without swallowing it', async () => {
    usePresetStore.setState({ view: view() });
    vi.mocked(client.sendMessage).mockRejectedValue(
      new client.ApiError('Azure request failed.', {
        kind: 'http',
        status: 502,
        hint: 'Run az login.',
      }),
    );

    await initialState.sendMessage('do something impossible');

    const turns = usePresetStore.getState().conversation;
    const last = turns[turns.length - 1];
    expect(last?.role).toBe('error');
    expect(last?.role === 'error' ? last.hint : undefined).toBe('Run az login.');
  });

  it('resets to the upload screen when the session has expired (404)', async () => {
    usePresetStore.setState({ view: view(), conversation: [{ id: 't', role: 'user', text: 'hi' }] });
    vi.mocked(client.sendMessage).mockRejectedValue(
      new client.ApiError('That session has expired.', { kind: 'not_found', status: 404 }),
    );

    await initialState.sendMessage('are you there?');

    const state = usePresetStore.getState();
    expect(state.view).toBeNull();
    expect(state.conversation).toEqual([]);
    expect(state.uploadError).toContain('expired');
  });
});
