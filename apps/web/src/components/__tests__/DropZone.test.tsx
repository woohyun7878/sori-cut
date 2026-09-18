import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropZone } from '../DropZone';
import { usePresetStore } from '../../store/usePresetStore';
import type { PresetView } from '../../api/types';

const createSession = vi.fn<(preset: string, filename: string) => Promise<PresetView>>();

vi.mock('../../api/client', async (importActual) => {
  const actual = await importActual<typeof import('../../api/client')>();
  return {
    ...actual,
    createSession: (preset: string, filename: string) => createSession(preset, filename),
  };
});

/**
 * A real Helix preset, so the store's local parse is exercised for real rather
 * than against a hand-written stub that only looks like one. Resolved from the
 * package root — under jsdom `import.meta.url` is an http: URL, not a file one.
 */
const POSSUM = readFileSync(
  resolve(process.cwd(), '../../packages/helix/test/fixtures/possum.hlx'),
  'utf8',
);

function presetFile(name: string, contents: string): File {
  return new File([contents], name, { type: 'application/json' });
}

function chooseFile(): HTMLInputElement {
  return screen.getByLabelText('Choose a Helix .hlx preset file') as HTMLInputElement;
}

afterEach(() => {
  vi.clearAllMocks();
  usePresetStore.setState({
    view: null,
    localPreview: null,
    uploadError: null,
    isUploading: false,
    sourceTemplateId: null,
  });
});

describe('DropZone', () => {
  it('rejects a file that is not a .hlx without spending a request', async () => {
    const user = userEvent.setup();
    render(<DropZone />);

    await user.upload(chooseFile(), presetFile('riff.wav', 'not a preset'));

    expect(await screen.findByText('That is not a .hlx file')).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects a preset over the server limit locally', async () => {
    const user = userEvent.setup();
    render(<DropZone />);

    await user.upload(chooseFile(), presetFile('bundle.hlx', 'x'.repeat(2048 * 1024 + 1)));

    expect(await screen.findByText('That preset is too large')).toBeInTheDocument();
    expect(screen.getByText(/must be under 2048 KB/)).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('explains a file that parses as nothing Helix recognises', async () => {
    const user = userEvent.setup();
    render(<DropZone />);

    await user.upload(chooseFile(), presetFile('broken.hlx', '{ not json'));

    expect(
      await screen.findByText('Bender could not open that preset'),
    ).toBeInTheDocument();
    expect(screen.getByText(/unmodified \.hlx exported from HX Edit/)).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('opens a session for a real preset', async () => {
    const user = userEvent.setup();
    createSession.mockResolvedValue({
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
    });

    render(<DropZone />);

    await user.upload(chooseFile(), presetFile('possum.hlx', POSSUM));

    await waitFor(() => expect(createSession).toHaveBeenCalledWith(POSSUM, 'possum.hlx'));
    expect(usePresetStore.getState().view?.sessionId).toBe('sess-1');
    expect(usePresetStore.getState().localPreview?.sizeBytes).toBeGreaterThan(0);
  });

  it('surfaces a backend failure where the file was chosen', async () => {
    const user = userEvent.setup();
    createSession.mockRejectedValue(new Error('Could not reach the Bender backend.'));

    render(<DropZone />);

    await user.upload(chooseFile(), presetFile('possum.hlx', POSSUM));

    expect(await screen.findByText('Bender could not open that preset')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another file' })).toBeInTheDocument();
  });
});
