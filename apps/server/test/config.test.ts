/**
 * Configuration, with particular attention to auth mode selection.
 *
 * This is worth testing carefully because getting it wrong produces a 403 that
 * looks like a bad key but is not one.
 */

import { describe, expect, it } from 'vitest';
import { ConfigError, describeAzure, loadConfig } from '../src/config.js';

const base = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-5.6-sol',
} as NodeJS.ProcessEnv;

describe('required settings', () => {
  it('refuses to start without an endpoint', () => {
    expect(() => loadConfig({ ...base, AZURE_OPENAI_ENDPOINT: '' })).toThrow(ConfigError);
  });

  it('refuses a non-https endpoint', () => {
    expect(() =>
      loadConfig({ ...base, AZURE_OPENAI_ENDPOINT: 'http://example.openai.azure.com' }),
    ).toThrow(/https/);
  });

  it('strips a trailing slash so URL joining is predictable', () => {
    const config = loadConfig({ ...base, AZURE_OPENAI_ENDPOINT: 'https://example.com/' });

    expect(config.azure.endpoint).toBe('https://example.com');
  });

  it('explains that deployment is not a model name', () => {
    // The error text matters: a model name here produces a 404 that reads
    // like the resource is missing.
    expect(() => loadConfig({ ...base, AZURE_OPENAI_DEPLOYMENT: '' })).toThrow(
      /not a model name/,
    );
  });
});

describe('auth mode', () => {
  it('defaults to Entra ID when no key is set', () => {
    expect(loadConfig(base).azure.authMode).toBe('entra');
  });

  it('uses the key when one is supplied', () => {
    const config = loadConfig({ ...base, AZURE_OPENAI_API_KEY: 'abc123' });

    expect(config.azure.authMode).toBe('api-key');
    expect(config.azure.apiKey).toBe('abc123');
  });

  it('honours an explicit request for Entra ID even when a key is present', () => {
    // The escape hatch for exactly the situation this project hit: a key is
    // available but the resource has key auth disabled.
    const config = loadConfig({
      ...base,
      AZURE_OPENAI_API_KEY: 'abc123',
      AZURE_OPENAI_AUTH_MODE: 'entra',
    });

    expect(config.azure.authMode).toBe('entra');
    expect(config.azure.apiKey).toBeUndefined();
  });

  it('rejects api-key mode with no key rather than silently using Entra ID', () => {
    expect(() => loadConfig({ ...base, AZURE_OPENAI_AUTH_MODE: 'api-key' })).toThrow(
      /AZURE_OPENAI_API_KEY is empty/,
    );
  });

  it('rejects an unrecognized auth mode', () => {
    expect(() => loadConfig({ ...base, AZURE_OPENAI_AUTH_MODE: 'oauth' })).toThrow(/entra/);
  });
});

describe('numeric settings', () => {
  it('falls back to defaults when unset', () => {
    const config = loadConfig(base);

    expect(config.port).toBe(8787);
    expect(config.maxToolIterations).toBeGreaterThan(0);
  });

  it('rejects a nonsensical value instead of quietly using a default', () => {
    expect(() => loadConfig({ ...base, PORT: 'eight' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MAX_SESSIONS: '-5' })).toThrow(ConfigError);
  });
});

describe('describeAzure', () => {
  it('never includes the key', () => {
    const config = loadConfig({ ...base, AZURE_OPENAI_API_KEY: 'super-secret-key-value' });
    const description = describeAzure(config.azure);

    expect(description).not.toContain('super-secret-key-value');
    expect(description).toContain('auth=api-key');
  });
});
