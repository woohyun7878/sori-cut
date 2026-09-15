/**
 * Thin client over the Bender backend.
 *
 * Everything the browser knows about the model lives behind this server. There
 * is deliberately no Azure endpoint, key or SDK here — the frontend only ever
 * talks to our own API.
 */

import type { MessageResponse, PresetView, TemplateSummary } from './types';

/**
 * Base URL of the backend, overridable at build time.
 *
 * Deliberately not `??`: an unset GitHub Actions variable expands to an empty
 * string rather than undefined, and `??` would keep it. The base URL would then
 * be "", every call would quietly become a same-origin request, and on Pages
 * that returns the SPA's own index.html with a 200 -- so the failure would
 * surface as a JSON parse error rather than as "there is no backend".
 */
export const API_BASE_URL = (
  import.meta.env.VITE_BENDER_API_URL?.trim() || 'http://localhost:8787'
).replace(/\/+$/, '');

export type ApiErrorKind = 'network' | 'not_found' | 'http';

/** A failure talking to the backend, carrying enough to explain it to a user. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly hint?: string;

  constructor(
    message: string,
    options: { kind: ApiErrorKind; status?: number; code?: string; hint?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.hint = options.hint;
  }

  /** True when the session no longer exists and the user should re-upload. */
  get sessionExpired(): boolean {
    return this.kind === 'not_found';
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
  hint?: string | null;
}

/**
 * Explain an unreachable backend in terms that match where the app is running.
 *
 * The Pages build is served over HTTPS from a public origin. If it is still
 * pointing at the default localhost backend, then VITE_BENDER_API_URL was not
 * set at build time -- and the browser will have blocked the request as mixed
 * content before it ever left the page. Telling a visitor to run
 * "pnpm dev:server" would be nonsense; telling them the backend is not deployed
 * yet is the truth.
 */
function networkMessage(): string {
  const pointingAtLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(API_BASE_URL);
  const servedRemotely =
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

  if (pointingAtLocalhost && servedRemotely) {
    return (
      'This build has no Bender backend configured, so tone requests cannot run here. ' +
      'Bender needs a server to reach Azure OpenAI — the model is never called from the browser. ' +
      'Run it locally to try it out.'
    );
  }

  return 'Could not reach the Bender backend. Start it with "pnpm dev:server" and try again.';
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    // fetch rejects (TypeError) when the server is unreachable or CORS blocks
    // the request — from the user's seat both mean "the backend isn't there".
    throw new ApiError(networkMessage(), { kind: 'network' });
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    const message = body.message ?? `Request failed (${response.status}).`;
    throw new ApiError(message, {
      kind: response.status === 404 ? 'not_found' : 'http',
      status: response.status,
      code: body.error,
      hint: body.hint ?? undefined,
    });
  }

  return response;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return (await response.json()) as T;
}

/** Upload a preset's text and open a server-side editing session. */
export async function createSession(preset: string, filename: string): Promise<PresetView> {
  return requestJson<PresetView>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ preset, filename }),
  });
}

/** Open a session from a curated starter template. */
export async function createSessionFromTemplate(templateId: string): Promise<PresetView> {
  return requestJson<PresetView>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  });
}

/** Send one natural-language request and get Bender's reply plus the new state. */
export async function sendMessage(id: string, message: string): Promise<MessageResponse> {
  return requestJson<MessageResponse>(`/api/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

/** Undo the last edit. The server nests the refreshed view under `preset`. */
export async function undo(id: string): Promise<PresetView> {
  const body = await requestJson<{ preset: PresetView }>(`/api/sessions/${id}/undo`, {
    method: 'POST',
  });
  return body.preset;
}

/** Redo the last undone edit. */
export async function redo(id: string): Promise<PresetView> {
  const body = await requestJson<{ preset: PresetView }>(`/api/sessions/${id}/redo`, {
    method: 'POST',
  });
  return body.preset;
}

/** Discard every edit and the conversation, returning to the uploaded preset. */
export async function reset(id: string): Promise<PresetView> {
  return requestJson<PresetView>(`/api/sessions/${id}/reset`, { method: 'POST' });
}

/** Best-effort release of a session. The server also evicts idle sessions. */
export async function deleteSession(id: string): Promise<void> {
  await request(`/api/sessions/${id}`, { method: 'DELETE' });
}

/** List curated starter templates. Empty by design until a real one is added. */
export async function getTemplates(): Promise<TemplateSummary[]> {
  const body = await requestJson<{ templates: TemplateSummary[] }>('/api/templates');
  return body.templates;
}

/** Fetch the current `.hlx` for download, with the server's suggested name. */
export async function fetchPresetBlob(
  id: string,
): Promise<{ blob: Blob; filename: string | null }> {
  const response = await request(`/api/sessions/${id}/preset`);
  const blob = await response.blob();
  return {
    blob,
    filename: parseContentDisposition(response.headers.get('content-disposition')),
  };
}

/** Extract the filename from a Content-Disposition header, if present. */
export function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const value = match?.[1];
  return value ? decodeURIComponent(value.trim()) : null;
}

/**
 * Derive the download name the server would use.
 *
 * A cross-origin fetch does not expose Content-Disposition unless the server
 * opts in, so this reproduces the server's own naming (`name-bender.hlx` when
 * modified, `name.hlx` otherwise) as a reliable fallback.
 */
export function deriveDownloadName(filename: string, modified: boolean): string {
  const base = filename.replace(/\.hlx$/i, '');
  return `${base}${modified ? '-bender' : ''}.hlx`;
}
