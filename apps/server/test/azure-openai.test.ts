/**
 * Azure provider translation layers.
 *
 * These test the pieces that turn the Responses API's shapes into ours, and
 * the error classification that decides whether a failure is worth retrying.
 * No network access: the SDK call itself is the one thing a unit test cannot
 * usefully cover, and the smoke script covers it live instead.
 */

import { describe, expect, it } from 'vitest';
import {
  readResponse,
  toResponsesInput,
  toResponsesTools,
  translateError,
} from '../src/model/azure-openai.js';
import { ModelError } from '../src/model/provider.js';
import { loadConfig } from '../src/config.js';

const azure = loadConfig({
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-5.6-sol',
} as NodeJS.ProcessEnv).azure;

describe('input conversion', () => {
  it('sends tool calls and their results as siblings, not nested', () => {
    // The Responses API puts function_call and function_call_output at the top
    // level of `input`. Nesting them inside an assistant message is the usual
    // mistake when porting from Chat Completions.
    const input = toResponsesInput([
      { type: 'message', role: 'user', content: 'more sustain' },
      { type: 'tool_call', callId: 'c1', name: 'inspect_block', arguments: '{"block":"dsp0/block1"}' },
      { type: 'tool_result', callId: 'c1', output: '{"ok":true}' },
    ]);

    expect(input).toEqual([
      { role: 'user', content: 'more sustain' },
      { type: 'function_call', call_id: 'c1', name: 'inspect_block', arguments: '{"block":"dsp0/block1"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ]);
  });
});

describe('tool conversion', () => {
  it('sends tools with strict disabled', () => {
    // Bender validates arguments itself and produces errors that name the bad
    // argument and list the alternatives. Provider-side strict rejection is
    // opaque by comparison and gives the model nothing to correct against.
    const tools = toResponsesTools([
      { name: 'set_parameter', description: 'd', parameters: { type: 'object', properties: {} } },
    ]);

    expect(tools[0]).toMatchObject({ type: 'function', name: 'set_parameter', strict: false });
  });
});

describe('response reading', () => {
  it('extracts assistant text', () => {
    const response = readResponse(
      { id: 'resp_1', output: [{ type: 'message', content: [{ text: 'Done.' }] }] },
      12,
    );

    expect(response.text).toBe('Done.');
    expect(response.id).toBe('resp_1');
    expect(response.latencyMs).toBe(12);
  });

  it('extracts function calls', () => {
    const response = readResponse(
      {
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'set_parameter',
            arguments: '{"block":"dsp0/block1"}',
          },
        ],
      },
      5,
    );

    expect(response.toolCalls).toEqual([
      { callId: 'call_1', name: 'set_parameter', arguments: '{"block":"dsp0/block1"}' },
    ]);
  });

  it('drops reasoning items rather than surfacing them', () => {
    // Raw chain-of-thought is not something the UI should be showing.
    const response = readResponse(
      {
        output: [
          { type: 'reasoning', summary: [], content: [{ text: 'internal deliberation' }] },
          { type: 'message', content: [{ text: 'Done.' }] },
        ],
      },
      1,
    );

    expect(response.text).toBe('Done.');
    expect(response.text).not.toContain('internal');
  });

  it('reports usage including reasoning tokens', () => {
    const response = readResponse(
      {
        output: [],
        usage: {
          input_tokens: 64,
          output_tokens: 64,
          total_tokens: 128,
          output_tokens_details: { reasoning_tokens: 40 },
        },
      },
      1,
    );

    expect(response.usage).toMatchObject({
      inputTokens: 64,
      outputTokens: 64,
      totalTokens: 128,
      reasoningTokens: 40,
    });
  });

  it('flags an incomplete response', () => {
    const response = readResponse(
      { output: [], status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      1,
    );

    expect(response.incomplete).toBe(true);
    expect(response.incompleteReason).toBe('max_output_tokens');
  });

  it('survives a payload with no output array', () => {
    expect(() => readResponse({}, 1)).not.toThrow();
  });
});

describe('error translation', () => {
  it('explains a disabled authentication type rather than blaming the key', () => {
    // The exact failure this project hit. Without the hint, the obvious
    // reaction is to go hunting for a fresh key, which cannot work.
    const error = translateError(
      { status: 403, message: 'AuthenticationTypeDisabled: Key based authentication is disabled' },
      { ...azure, authMode: 'api-key' },
    );

    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.hint).toContain('key authentication disabled');
    expect(error.hint).toContain('az login');
  });

  it('explains a 404 as a deployment name problem', () => {
    const error = translateError({ status: 404, message: 'DeploymentNotFound' }, azure);

    expect(error.kind).toBe('not_found');
    expect(error.hint).toContain('not a model name');
  });

  it('marks a rate limit retryable', () => {
    expect(translateError({ status: 429, message: 'Too Many Requests' }, azure).retryable).toBe(true);
  });

  it('marks a server error retryable', () => {
    expect(translateError({ status: 503, message: 'unavailable' }, azure).retryable).toBe(true);
  });

  it('does not mark a bad request retryable', () => {
    expect(translateError({ status: 400, message: 'bad schema' }, azure).retryable).toBe(false);
  });

  it('classifies network failures', () => {
    const error = translateError({ code: 'ENOTFOUND' }, azure);

    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('classifies aborts as timeouts', () => {
    expect(translateError({ name: 'AbortError' }, azure).kind).toBe('timeout');
  });

  it('classifies content filtering', () => {
    expect(translateError({ status: 400, code: 'content_filter' }, azure).kind).toBe(
      'content_filter',
    );
  });

  it('passes an existing ModelError through unchanged', () => {
    const original = new ModelError('auth', 'already classified');

    expect(translateError(original, azure)).toBe(original);
  });

  it('never leaks the key into the message', () => {
    const withKey = { ...azure, authMode: 'api-key' as const, apiKey: 'super-secret' };
    const error = translateError({ status: 401, message: 'Unauthorized' }, withKey);

    expect(error.message).not.toContain('super-secret');
    expect(error.hint ?? '').not.toContain('super-secret');
  });
});
