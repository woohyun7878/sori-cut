/**
 * Server entry point.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ConfigError, loadConfig, describeAzure, type ServerConfig } from './config.js';
import { AzureOpenAIProvider } from './model/azure-openai.js';
import type { ModelProvider } from './model/provider.js';
import { SessionStore } from './store.js';
import { registerRoutes } from './http/routes.js';
import { createLogger, type Logger } from './observability.js';

export interface BuildOptions {
  config: ServerConfig;
  /** Overridable so tests can run the whole HTTP surface without Azure. */
  provider?: ModelProvider;
  logger?: Logger;
}

export async function buildServer({ config, provider, logger }: BuildOptions) {
  const log = logger ?? createLogger(config.logLevel);

  const app = Fastify({
    // Fastify's own logger is off: this app logs structured events itself, and
    // two logging systems means half the story in each.
    logger: false,
    bodyLimit: config.maxPresetBytes + 64 * 1024,
  });

  await app.register(cors, {
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : true,
    methods: ['GET', 'POST', 'DELETE'],
  });

  const store = new SessionStore({
    ttlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
  });

  registerRoutes(app, {
    config,
    store,
    provider: provider ?? new AzureOpenAIProvider(config.azure),
    logger: log,
  });

  app.setErrorHandler((error: { message: string; statusCode?: number }, _request, reply) => {
    log.error('request.failed', { message: error.message, statusCode: error.statusCode });
    void reply
      .code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
      .send({ error: 'internal_error', message: error.message });
  });

  const sweep = setInterval(() => {
    const removed = store.evictExpired();
    if (removed > 0) log.debug('sessions.evicted', { removed });
  }, 60_000);
  sweep.unref();

  app.addHook('onClose', async () => clearInterval(sweep));

  return { app, store, logger: log };
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfiguration error: ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const { app, logger } = await buildServer({ config });

  logger.info('server.starting', {
    port: config.port,
    host: config.host,
    model: describeAzure(config.azure),
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info('server.listening', { url: `http://${config.host}:${config.port}` });
  } catch (error) {
    logger.error('server.failed', { message: String(error) });
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('server.stopping', { signal });
      void app.close().then(() => process.exit(0));
    });
  }
}

// Only start when run directly, so importing this module in tests is safe.
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  await main();
}
