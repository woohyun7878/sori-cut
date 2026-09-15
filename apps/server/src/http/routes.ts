/**
 * HTTP API.
 *
 * The browser never sees Azure. It uploads a preset, sends messages, and
 * downloads the result; the credential and the model call stay on this side.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ToneSession, type ToolCallOutcome } from '@bender/tone-tools';
import type { ServerConfig } from '../config.js';
import { describeAzure } from '../config.js';
import { ModelError, type ModelProvider } from '../model/provider.js';
import { runAgentTurn } from '../agent/loop.js';
import type { SessionStore, StoredSession } from '../store.js';
import { requestId, type Logger } from '../observability.js';
import { listTemplates, loadTemplate } from '../templates.js';

export interface RouteDeps {
  config: ServerConfig;
  store: SessionStore;
  provider: ModelProvider;
  logger: Logger;
}

/** Everything the UI needs to render the current state of a preset. */
function presetView(stored: StoredSession) {
  const { session } = stored;
  const summary = session.preset.summary();

  return {
    sessionId: stored.id,
    filename: stored.filename,
    name: summary.name ?? null,
    device: summary.deviceName ?? null,
    deviceId: summary.device ?? null,
    firmware: summary.firmware ?? null,
    tempo: summary.tempo ?? null,
    chain: session.preset.blocks().map((block) => ({
      id: `${block.dsp}/${block.slot}`,
      label: block.label,
      model: block.model,
      role: block.role,
      path: block.path,
      position: block.position,
      enabled: block.enabled,
      cab: block.cabSlot ?? null,
    })),
    snapshots: summary.snapshots.map((s) => ({ index: s.index, name: s.name ?? null })),
    activeSnapshot: summary.currentSnapshot ?? null,
    modified: session.isModified,
    canUndo: session.canUndo,
    canRedo: session.canRedo,
    diff: session.diff(),
    edits: session.edits.map((edit) => ({
      sequence: edit.sequence,
      tool: edit.tool,
      summary: edit.summary,
      target: edit.target,
      parameter: edit.parameter ?? null,
      before: edit.before ?? null,
      after: edit.after ?? null,
    })),
  };
}

function toolView(outcome: ToolCallOutcome) {
  return {
    name: outcome.name,
    ok: outcome.ok,
    durationMs: outcome.durationMs,
    error: outcome.result.ok ? null : outcome.result.error.code,
    warnings: outcome.result.warnings,
  };
}

function findSession(
  deps: RouteDeps,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): StoredSession | undefined {
  const stored = deps.store.get(request.params.id);
  if (!stored) {
    void reply.code(404).send({
      error: 'session_not_found',
      message: 'That session has expired or does not exist. Upload the preset again.',
    });
    return undefined;
  }
  return stored;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, store, provider, logger } = deps;

  app.get('/api/health', async () => ({
    status: 'ok',
    // Safe to expose: endpoint, deployment and auth mode are configuration,
    // not credentials, and knowing them is what makes a failed demo debuggable.
    model: describeAzure(config.azure),
    activeSessions: store.size,
  }));

  app.get('/api/templates', async () => ({ templates: listTemplates() }));

  app.post<{ Body: { preset?: unknown; filename?: unknown; templateId?: unknown } }>(
    '/api/sessions',
    async (request, reply) => {
      const body = request.body ?? {};
      let text: string;
      let filename: string;

      if (typeof body.templateId === 'string') {
        const template = loadTemplate(body.templateId);
        if (!template) {
          return reply.code(404).send({
            error: 'unknown_template',
            message: `No starter template with id "${body.templateId}".`,
          });
        }
        text = template.preset;
        filename = `${template.id}.hlx`;
      } else {
        if (typeof body.preset !== 'string' || body.preset.trim() === '') {
          return reply
            .code(400)
            .send({ error: 'missing_preset', message: 'Send the .hlx file contents as "preset".' });
        }
        text = body.preset;
        filename =
          typeof body.filename === 'string' && body.filename.trim() ? body.filename : 'preset.hlx';
      }

      if (Buffer.byteLength(text, 'utf8') > config.maxPresetBytes) {
        return reply.code(413).send({
          error: 'preset_too_large',
          message: `Presets must be under ${Math.round(config.maxPresetBytes / 1024)} KB.`,
        });
      }

      const opened = ToneSession.open(text);
      if ('error' in opened) {
        // A refusal to open is a normal outcome for a corrupt file, so it is
        // reported with the reason rather than as a server error.
        logger.info('session.rejected', { filename, code: opened.error.code });
        return reply.code(422).send({
          error: opened.error.code,
          message: opened.error.message,
          suggestions: opened.error.suggestions ?? [],
        });
      }

      const stored = store.create(requestId(), opened.session, filename);
      logger.info('session.opened', {
        sessionId: stored.id,
        device: opened.session.preset.summary().deviceName,
        blocks: opened.session.preset.blocks().length,
      });

      return reply.code(201).send({ ...presetView(stored), warnings: opened.warnings });
    },
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const stored = findSession(deps, request, reply);
    return stored ? presetView(stored) : undefined;
  });

  app.post<{ Params: { id: string }; Body: { message?: unknown } }>(
    '/api/sessions/:id/messages',
    async (request, reply) => {
      const stored = findSession(deps, request, reply);
      if (!stored) return undefined;

      const message = request.body?.message;
      if (typeof message !== 'string' || message.trim() === '') {
        return reply
          .code(400)
          .send({ error: 'empty_message', message: 'Tell Bender what you want changed.' });
      }

      const id = requestId();
      const turnLogger = logger.child({ requestId: id, sessionId: stored.id });
      turnLogger.info('turn.start', { chars: message.length });

      try {
        const result = await runAgentTurn(
          provider,
          {
            session: stored.session,
            executor: stored.executor,
            message: message.trim(),
            history: stored.history,
          },
          { maxIterations: config.maxToolIterations, logger: turnLogger },
        );

        turnLogger.info('turn.done', {
          iterations: result.iterations,
          toolCalls: result.toolCalls.length,
          latencyMs: result.totalLatencyMs,
          usage: result.usage,
          modelRequestIds: result.modelRequestIds,
        });

        return reply.send({
          reply: result.reply,
          activity: result.activity,
          toolCalls: result.toolCalls.map(toolView),
          truncated: result.truncated,
          latencyMs: result.totalLatencyMs,
          modelRequestIds: result.modelRequestIds,
          preset: presetView(stored),
        });
      } catch (error) {
        const modelError =
          error instanceof ModelError ? error : new ModelError('unknown', String(error));

        turnLogger.error('turn.failed', {
          kind: modelError.kind,
          status: modelError.status,
          message: modelError.message,
        });

        // 502 rather than 500: the failure is upstream, and the distinction
        // tells whoever is debugging the demo where to look.
        return reply.code(modelError.kind === 'auth' ? 502 : 502).send({
          error: modelError.kind,
          message: modelError.message,
          hint: modelError.hint ?? null,
          retryable: modelError.retryable,
          preset: presetView(stored),
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/undo', async (request, reply) => {
    const stored = findSession(deps, request, reply);
    if (!stored) return undefined;

    const result = stored.session.undo();
    if (!result.ok) {
      return reply.code(409).send({ error: result.error.code, message: result.error.message });
    }
    return reply.send({ undone: result.data.summary, preset: presetView(stored) });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/redo', async (request, reply) => {
    const stored = findSession(deps, request, reply);
    if (!stored) return undefined;

    const result = stored.session.redo();
    if (!result.ok) {
      return reply.code(409).send({ error: result.error.code, message: result.error.message });
    }
    return reply.send({ redone: result.data.summary, preset: presetView(stored) });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/reset', async (request, reply) => {
    const stored = findSession(deps, request, reply);
    if (!stored) return undefined;

    stored.session.reset();
    // The conversation is cleared too. Leaving it would have the model
    // reasoning about edits that no longer exist.
    stored.history = [];
    return reply.send(presetView(stored));
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/preset', async (request, reply) => {
    const stored = findSession(deps, request, reply);
    if (!stored) return undefined;

    const name = stored.filename.replace(/\.hlx$/i, '');
    const suffix = stored.session.isModified ? '-bender' : '';

    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}${suffix}.hlx"`)
      .send(stored.session.serialize());
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    store.delete(request.params.id);
    return reply.code(204).send();
  });
}
