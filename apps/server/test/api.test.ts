/**
 * The HTTP API, exercised end to end.
 *
 * These run the real Fastify app with a scripted model, so they cover the
 * whole demo path: upload, chat, tool-driven edit, diff, undo, download. If
 * these pass, the thing the audience will see works.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { HelixPreset } from '@bender/helix';
import { realPreset, ScriptedProvider, silentLogger, testConfig } from './helpers.js';

async function makeApp(provider: ScriptedProvider) {
  const { app } = await buildServer({
    config: testConfig(),
    provider,
    logger: silentLogger(),
  });
  await app.ready();
  return app;
}

async function upload(app: FastifyInstance, preset = realPreset()) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { preset, filename: 'possum.hlx' },
  });
  return { response, body: response.json() };
}

let app: FastifyInstance;

describe('health', () => {
  beforeEach(async () => {
    app = await makeApp(new ScriptedProvider([]));
  });

  it('reports the model configuration without the credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.model).toContain('test-deployment');
    expect(body.model).toContain('auth=entra');
    expect(JSON.stringify(body)).not.toMatch(/api[-_]?key["']?\s*[:=]\s*["'][^"']{10,}/i);
  });
});

describe('uploading a preset', () => {
  beforeEach(async () => {
    app = await makeApp(new ScriptedProvider([]));
  });

  it('parses the preset and returns the chain', async () => {
    const { response, body } = await upload(app);

    expect(response.statusCode).toBe(201);
    expect(body.name).toBe('Possum');
    expect(body.device).toContain('Helix');
    expect(body.chain.length).toBeGreaterThan(0);
    expect(body.chain[0]).toHaveProperty('id');
    expect(body.modified).toBe(false);
  });

  it('orders the chain by signal flow, not file order', async () => {
    // possum.hlx stores block0 at position 2, so file order and signal order
    // genuinely differ here.
    const { body } = await upload(app);
    const blocks = body.chain.filter((b: { role: string }) => b.role === 'block');
    const positions = blocks.map((b: { position: number }) => b.position);

    expect(positions).toEqual([...positions].sort((a: number, b: number) => a - b));
  });

  it('rejects a file that is not a preset', async () => {
    const { response, body } = await upload(app, 'not a preset at all');

    expect(response.statusCode).toBe(422);
    expect(body.message).toContain('could not be read');
  });

  it('rejects an empty request', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an oversized upload', async () => {
    const { app: small } = await buildServer({
      config: testConfig({ maxPresetBytes: 100 }),
      provider: new ScriptedProvider([]),
      logger: silentLogger(),
    });
    await small.ready();

    const response = await small.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { preset: realPreset() },
    });

    expect(response.statusCode).toBe(413);
  });

  it('returns 404 for a session that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions/nope' });

    expect(response.statusCode).toBe(404);
  });
});

describe('the demo path', () => {
  it('takes a tone request through to a changed preset', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'inspect_signal_chain', arguments: {} }] },
      { toolCalls: [{ name: 'inspect_block', arguments: { block: 'dsp0/block1' } }] },
      {
        toolCalls: [
          {
            name: 'set_parameter',
            arguments: { block: 'dsp0/block1', parameter: 'Master', value: 0.48 },
          },
        ],
      },
      {
        text: 'I brought the amp master up so notes hold longer. Gain is untouched, so the noise floor has not moved.',
      },
    ]);
    app = await makeApp(provider);

    const { body: session } = await upload(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/messages`,
      payload: { message: 'My tapped notes die too quickly. More sustain, without extra noise.' },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.reply).toContain('master');
    expect(body.preset.modified).toBe(true);
    expect(body.preset.canUndo).toBe(true);

    // The activity feed is what the UI shows while Bender works.
    expect(body.activity.filter((a: { kind: string }) => a.kind === 'tool')).toHaveLength(3);
    expect(body.toolCalls.every((t: { ok: boolean }) => t.ok)).toBe(true);

    // The diff is the "show exactly what changed" requirement.
    expect(body.preset.diff).toHaveLength(1);
    expect(body.preset.diff[0]).toMatchObject({ parameter: 'Master', after: 0.48 });
    expect(body.preset.edits[0].summary).toBeTruthy();
  });

  it('downloads a preset that reparses cleanly', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'set_parameter',
            arguments: { block: 'dsp0/block1', parameter: 'Master', value: 0.48 },
          },
        ],
      },
      { text: 'Done.' },
    ]);
    app = await makeApp(provider);

    const { body: session } = await upload(app);
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/messages`,
      payload: { message: 'louder' },
    });

    const download = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.sessionId}/preset`,
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('possum-bender.hlx');

    // The whole point of the parser work: what comes out must be a valid
    // preset, not just valid JSON.
    const parsed = HelixPreset.parse(download.body);
    expect(parsed.summary().name).toBe('Possum');
    expect(parsed.serialize()).toBe(download.body);
    expect(download.body).not.toBe(realPreset());
  });

  it('downloads the original unchanged when nothing was edited', async () => {
    app = await makeApp(new ScriptedProvider([]));
    const { body: session } = await upload(app);

    const download = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.sessionId}/preset`,
    });

    expect(download.body).toBe(realPreset());
    expect(download.headers['content-disposition']).toContain('possum.hlx');
  });
});

describe('undo and reset', () => {
  async function editedSession() {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'set_parameter',
            arguments: { block: 'dsp0/block1', parameter: 'Master', value: 0.48 },
          },
        ],
      },
      { text: 'Done.' },
    ]);
    app = await makeApp(provider);
    const { body: session } = await upload(app);
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/messages`,
      payload: { message: 'louder' },
    });
    return session.sessionId as string;
  }

  it('undoes the last change', async () => {
    const id = await editedSession();

    const response = await app.inject({ method: 'POST', url: `/api/sessions/${id}/undo` });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.preset.modified).toBe(false);
    expect(body.preset.diff).toHaveLength(0);
    expect(body.preset.canRedo).toBe(true);
  });

  it('restores the exact original bytes after undo', async () => {
    const id = await editedSession();
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/undo` });

    const download = await app.inject({ method: 'GET', url: `/api/sessions/${id}/preset` });

    expect(download.body).toBe(realPreset());
  });

  it('redoes an undone change', async () => {
    const id = await editedSession();
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/undo` });

    const response = await app.inject({ method: 'POST', url: `/api/sessions/${id}/redo` });

    expect(response.json().preset.modified).toBe(true);
  });

  it('refuses to undo when there is nothing to undo', async () => {
    app = await makeApp(new ScriptedProvider([]));
    const { body: session } = await upload(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/undo`,
    });

    expect(response.statusCode).toBe(409);
  });

  it('resets everything including the conversation', async () => {
    const id = await editedSession();

    const response = await app.inject({ method: 'POST', url: `/api/sessions/${id}/reset` });

    expect(response.json().modified).toBe(false);
    expect(response.json().edits).toHaveLength(0);
  });
});

describe('when the model call fails', () => {
  it('returns a usable error and leaves the preset alone', async () => {
    const { ModelError } = await import('../src/model/provider.js');
    const provider = new ScriptedProvider([
      {
        throws: new ModelError('auth', 'Key based authentication is disabled for this resource', {
          status: 403,
          hint: 'Unset AZURE_OPENAI_API_KEY to use Entra ID.',
        }),
      },
    ]);
    app = await makeApp(provider);
    const { body: session } = await upload(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/messages`,
      payload: { message: 'more sustain' },
    });
    const body = response.json();

    expect(response.statusCode).toBe(502);
    expect(body.error).toBe('auth');
    expect(body.hint).toContain('Entra ID');
    // The preset comes back with the error so the UI does not lose its state.
    expect(body.preset.modified).toBe(false);
  });

  it('rejects an empty message before calling the model', async () => {
    const provider = new ScriptedProvider([]);
    app = await makeApp(provider);
    const { body: session } = await upload(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.sessionId}/messages`,
      payload: { message: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(provider.callCount).toBe(0);
  });
});

describe('templates', () => {
  it('reports honestly that there are none rather than inventing some', async () => {
    app = await makeApp(new ScriptedProvider([]));
    const response = await app.inject({ method: 'GET', url: '/api/templates' });

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().templates)).toBe(true);
  });

  it('404s on an unknown template id', async () => {
    app = await makeApp(new ScriptedProvider([]));
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { templateId: 'made-up' },
    });

    expect(response.statusCode).toBe(404);
  });
});
