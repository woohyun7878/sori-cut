/**
 * Server configuration.
 *
 * Everything the model path needs comes from the environment. Nothing here is
 * ever sent to the browser -- the frontend talks to this server, and this
 * server talks to Azure.
 */

export type AuthMode = 'entra' | 'api-key';

export interface AzureConfig {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  authMode: AuthMode;
  apiKey?: string;
  /** Scope requested for Entra ID tokens. */
  scope: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Allowed browser origins. Empty means same-origin only. */
  allowedOrigins: string[];
  /** Largest preset upload accepted, in bytes. */
  maxPresetBytes: number;
  /** How long an idle tone session is kept before eviction, in ms. */
  sessionTtlMs: number;
  maxSessions: number;
  /** Ceiling on model/tool round trips in one request. */
  maxToolIterations: number;
  azure: AzureConfig;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Expected a positive number, got "${value}".`);
  }
  return Math.floor(parsed);
}

/**
 * Build configuration from environment variables.
 *
 * Auth mode deserves explanation. The obvious choice is an API key, and that
 * is what most Azure OpenAI samples show. But key authentication can be
 * disabled at the resource level, and when it is, key requests fail with 403
 * AuthenticationTypeDisabled no matter how valid the key is -- which is the
 * case on the resource this project was handed. So Entra ID is the default and
 * a key is used only when one is explicitly supplied.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const endpoint = (env.AZURE_OPENAI_ENDPOINT ?? '').trim().replace(/\/+$/, '');
  if (!endpoint) {
    throw new ConfigError(
      'AZURE_OPENAI_ENDPOINT is not set. Copy apps/server/.env.example to apps/server/.env and fill it in.',
    );
  }
  if (!/^https:\/\//i.test(endpoint)) {
    throw new ConfigError(`AZURE_OPENAI_ENDPOINT must be an https URL, got "${endpoint}".`);
  }

  const deployment = (env.AZURE_OPENAI_DEPLOYMENT ?? '').trim();
  if (!deployment) {
    throw new ConfigError(
      'AZURE_OPENAI_DEPLOYMENT is not set. This is the deployment name from your Azure resource, ' +
        'not a model name -- using a model name produces a 404 DeploymentNotFound.',
    );
  }

  const apiKey = (env.AZURE_OPENAI_API_KEY ?? '').trim();
  const requested = (env.AZURE_OPENAI_AUTH_MODE ?? '').trim().toLowerCase();

  let authMode: AuthMode;
  if (requested === 'api-key' || requested === 'key') {
    if (!apiKey) {
      throw new ConfigError('AZURE_OPENAI_AUTH_MODE=api-key but AZURE_OPENAI_API_KEY is empty.');
    }
    authMode = 'api-key';
  } else if (requested === 'entra' || requested === 'aad') {
    authMode = 'entra';
  } else if (requested !== '') {
    throw new ConfigError(
      `AZURE_OPENAI_AUTH_MODE must be "entra" or "api-key", got "${requested}".`,
    );
  } else {
    authMode = apiKey ? 'api-key' : 'entra';
  }

  return {
    port: int(env.PORT, 8787),
    host: (env.HOST ?? '127.0.0.1').trim(),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    maxPresetBytes: int(env.MAX_PRESET_BYTES, 2 * 1024 * 1024),
    sessionTtlMs: int(env.SESSION_TTL_MS, 60 * 60 * 1000),
    maxSessions: int(env.MAX_SESSIONS, 200),
    maxToolIterations: int(env.MAX_TOOL_ITERATIONS, 12),
    logLevel: (env.LOG_LEVEL ?? 'info') as ServerConfig['logLevel'],
    azure: {
      endpoint,
      deployment,
      apiVersion: (env.AZURE_OPENAI_API_VERSION ?? '2025-04-01-preview').trim(),
      authMode,
      apiKey: authMode === 'api-key' ? apiKey : undefined,
      scope: (env.AZURE_OPENAI_SCOPE ?? 'https://cognitiveservices.azure.com/.default').trim(),
    },
  };
}

/**
 * A one-line description of the model path, safe to log.
 *
 * Logged at startup and used in local diagnostics. It is deliberately *not*
 * served from `/api/health`: that endpoint is public, and naming the resource
 * and deployment there points anyone holding a stray key straight at the
 * target.
 */
export function describeAzure(config: AzureConfig): string {
  return `${config.endpoint} deployment=${config.deployment} api-version=${config.apiVersion} auth=${config.authMode}`;
}
