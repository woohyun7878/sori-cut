import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE_URL,
  ApiError,
  createSession,
  deriveDownloadName,
  parseContentDisposition,
  sendMessage,
  undo,
} from '../client';
import type { PresetView } from '../types';

interface StubInit {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function stubResponse({ ok, status, body, headers = {} }: StubInit) {
  return {
    ok,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([JSON.stringify(body)])),
  };
}

function mockFetch(response: ReturnType<typeof stubResponse>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseContentDisposition', () => {
  it('extracts the filename from an attachment header', () => {
    expect(parseContentDisposition('attachment; filename="possum-bender.hlx"')).toBe(
      'possum-bender.hlx',
    );
  });

  it('returns null when there is no header', () => {
    expect(parseContentDisposition(null)).toBeNull();
  });
});

describe('deriveDownloadName', () => {
  it('adds the -bender suffix when modified', () => {
    expect(deriveDownloadName('possum.hlx', true)).toBe('possum-bender.hlx');
  });

  it('keeps the original name when unmodified', () => {
    expect(deriveDownloadName('possum.hlx', false)).toBe('possum.hlx');
  });
});

describe('error handling', () => {
  it('reports the backend as unreachable and points at pnpm dev:server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await createSession('{}', 'x.hlx').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('network');
    expect((error as ApiError).message).toContain('pnpm dev:server');
  });

  // On the deployed Pages build, "run pnpm dev:server" is advice a visitor
  // cannot act on, and the request never leaves the page anyway -- an HTTPS
  // origin calling http://localhost is blocked as mixed content. The honest
  // message is that this build has no backend.
  it('tells a visitor to a deployed build that there is no backend, not to run a dev server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.stubGlobal('window', {
      location: { protocol: 'https:', hostname: 'soricut.studio' },
    });

    const error = await createSession('{}', 'x.hlx').catch((e: unknown) => e);

    expect((error as ApiError).message).toContain('no Bender backend configured');
    expect((error as ApiError).message).not.toContain('pnpm dev:server');
  });

  it('keeps the dev-server hint when a developer runs the build locally over http', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: 'localhost' },
    });

    const error = await createSession('{}', 'x.hlx').catch((e: unknown) => e);

    expect((error as ApiError).message).toContain('pnpm dev:server');
  });
});

describe('API_BASE_URL', () => {
  // An unset GitHub Actions variable expands to "" rather than undefined. With
  // `??` that empty string wins, the base URL becomes "", and every call turns
  // into a same-origin request -- which on Pages returns index.html with a 200,
  // so the failure would surface as a JSON parse error instead of "no backend".
  it('never resolves to an empty base url', () => {
    expect(API_BASE_URL).not.toBe('');
    expect(API_BASE_URL).toMatch(/^https?:\/\//);
  });

  it('carries no trailing slash, so path joins cannot double up', () => {
    expect(API_BASE_URL).not.toMatch(/\/$/);
  });
});

describe('http failures', () => {
  it('marks a 404 as an expired session', async () => {
    mockFetch(
      stubResponse({
        ok: false,
        status: 404,
        body: { error: 'session_not_found', message: 'That session has expired.' },
      }),
    );

    const error = await sendMessage('gone', 'hi').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).sessionExpired).toBe(true);
    expect((error as ApiError).message).toBe('That session has expired.');
  });

  it('surfaces the server message and code for a rejected upload', async () => {
    mockFetch(
      stubResponse({
        ok: false,
        status: 422,
        body: { error: 'would_corrupt', message: 'This file could not be read as a Helix preset.' },
      }),
    );

    const error = await createSession('nope', 'x.hlx').catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe('would_corrupt');
    expect((error as ApiError).message).toContain('could not be read');
  });

  it('carries the actionable hint from a model failure', async () => {
    mockFetch(
      stubResponse({
        ok: false,
        status: 502,
        body: {
          error: 'auth',
          message: 'Key based authentication is disabled for this resource.',
          hint: 'Unset AZURE_OPENAI_API_KEY to use Entra ID.',
        },
      }),
    );

    const error = await sendMessage('sess-1', 'louder').catch((e: unknown) => e);

    expect((error as ApiError).hint).toContain('Entra ID');
  });
});

describe('happy paths', () => {
  it('returns the preset view from create-session', async () => {
    mockFetch(stubResponse({ ok: true, status: 201, body: view() }));

    const result = await createSession('{}', 'possum.hlx');

    expect(result.name).toBe('Possum');
  });

  it('unwraps the nested preset from undo', async () => {
    mockFetch(stubResponse({ ok: true, status: 200, body: { preset: view({ modified: false }) } }));

    const result = await undo('sess-1');

    expect(result.sessionId).toBe('sess-1');
  });
});
