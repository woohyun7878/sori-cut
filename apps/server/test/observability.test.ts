/**
 * Logging, with the emphasis on what must never appear in it.
 *
 * The Azure key will end up in environments, error messages and stack traces.
 * These tests are the standing guarantee that it does not also end up in a log
 * file someone pastes into a chat window.
 *
 * The constant below is synthetic. It matches the real credential's shape --
 * 84 characters, alphanumeric, no separators -- because that shape is what the
 * `[A-Za-z0-9]{60,}` rule keys off, so the test is exactly as strong as it
 * would be with a live key. Using the real one made this file a place a working
 * credential was committed in plain text, which GitHub push protection caught
 * and was right to reject: a test proving secrets stay out of logs should not
 * itself be how one reaches the repository.
 */

import { describe, expect, it } from 'vitest';
import { createLogger, redact, requestId } from '../src/observability.js';
import { capturingLogger } from './helpers.js';

const REAL_SHAPED_KEY =
  'NOTAREALKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789a';

describe('redaction', () => {
  it('removes values under obviously sensitive keys', () => {
    const out = redact({ apiKey: 'secret', api_key: 'secret', authorization: 'Bearer x' }) as Record<
      string,
      unknown
    >;

    expect(out.apiKey).toBe('[redacted]');
    expect(out.api_key).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
  });

  it('removes a long key pasted into an innocent-looking field', () => {
    // This is how credentials actually reach logs: inside an error message,
    // not in a field somebody thought to call "apiKey".
    const out = redact({ message: `request failed with key ${REAL_SHAPED_KEY}` }) as {
      message: string;
    };

    expect(out.message).not.toContain(REAL_SHAPED_KEY);
    expect(out.message).toContain('[redacted]');
  });

  it('removes bearer tokens', () => {
    const out = redact('Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijk') as string;

    expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('removes the preset, which is the user\u2019s own work', () => {
    const out = redact({ preset: '{"schema":"L6Preset"}', presetText: 'x' }) as Record<
      string,
      unknown
    >;

    expect(out.preset).toBe('[redacted]');
    expect(out.presetText).toBe('[redacted]');
  });

  it('reaches into nested objects and arrays', () => {
    const out = redact({ azure: { config: { apiKey: 'secret' } }, list: [{ token: 'secret' }] }) as {
      azure: { config: { apiKey: string } };
      list: { token: string }[];
    };

    expect(out.azure.config.apiKey).toBe('[redacted]');
    expect(out.list[0].token).toBe('[redacted]');
  });

  it('stops rather than recursing forever on a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;

    expect(() => redact(cyclic)).not.toThrow();
  });

  it('truncates very long strings', () => {
    // Long prose, not a long token: an unbroken alphanumeric run that size is
    // secret-shaped and gets redacted outright, which is the behaviour above.
    const out = redact('some long log line '.repeat(400)) as string;

    expect(out.length).toBeLessThan(2100);
    expect(out).toContain('truncated');
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ tool: 'set_parameter', durationMs: 12, ok: true })).toEqual({
      tool: 'set_parameter',
      durationMs: 12,
      ok: true,
    });
  });
});

describe('logger', () => {
  it('writes one JSON object per line', () => {
    const { logger, lines } = capturingLogger();
    logger.info('tool.call', { tool: 'set_parameter' });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe('tool.call');
    expect(parsed.level).toBe('info');
    expect(parsed.ts).toBeTruthy();
  });

  it('redacts fields on the way out', () => {
    const { logger, lines } = capturingLogger();
    logger.error('model.failed', { message: `bad key ${REAL_SHAPED_KEY}` });

    expect(lines[0]).not.toContain(REAL_SHAPED_KEY);
  });

  it('honours the level threshold', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', {}, (line) => lines.push(line));

    logger.debug('a');
    logger.info('b');
    logger.warn('c');

    expect(lines).toHaveLength(1);
  });

  it('stamps child fields onto every line', () => {
    const { logger, lines } = capturingLogger();
    logger.child({ sessionId: 'abc' }).info('turn.start');

    expect(JSON.parse(lines[0]).sessionId).toBe('abc');
  });

  it('redacts child fields too', () => {
    const { logger, lines } = capturingLogger();
    logger.child({ apiKey: REAL_SHAPED_KEY }).info('turn.start');

    expect(lines[0]).not.toContain(REAL_SHAPED_KEY);
  });

  it('never throws on unserializable input', () => {
    const lines: string[] = [];
    const logger = createLogger('info', {}, (line) => lines.push(line));

    expect(() => logger.info('weird', { value: BigInt(1) })).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('requestId', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => requestId()));

    expect(ids.size).toBeGreaterThan(490);
  });
});
