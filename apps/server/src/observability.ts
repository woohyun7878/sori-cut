/**
 * Structured logging.
 *
 * Two rules shape this file. Logs are JSON lines so an R&D session can be
 * grepped and replayed. And nothing sensitive goes in them: not the API key,
 * not bearer tokens, and not the contents of the user's preset. A preset is
 * someone's work, and a log that dumps it is a log nobody can share.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** A logger that stamps every line with additional fields. */
  child(fields: Record<string, unknown>): Logger;
}

/** Field names whose values are replaced wholesale. */
const SECRET_KEYS =
  /^(api[-_]?key|authorization|auth|token|access[-_]?token|bearer|password|secret|client[-_]?secret|preset|presetText|fileContents)$/i;

/**
 * Patterns that catch a secret pasted into an otherwise innocent field, which
 * is how credentials usually reach logs -- inside an error message, not in a
 * field somebody thought to name "apiKey".
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9._-]{30,}/g, '[redacted-jwt]'],
  [/\b[A-Za-z0-9]{60,}\b/g, '[redacted]'],
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[too-deep]';

  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out;
  }

  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(inner, depth + 1);
    }
    return out;
  }

  return value;
}

export function createLogger(
  level: LogLevel = 'info',
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = ORDER[level] ?? ORDER.info;

  const write = (lineLevel: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (ORDER[lineLevel] < threshold) return;

    const payload = {
      ts: new Date().toISOString(),
      level: lineLevel,
      event,
      ...base,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };

    try {
      sink(JSON.stringify(payload));
    } catch {
      // A log line must never be the reason a request fails.
      sink(JSON.stringify({ ts: payload.ts, level: lineLevel, event, error: 'unserializable' }));
    }
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger(level, { ...base, ...(redact(fields) as object) }, sink),
  };
}

/** Short, collision-resistant id for correlating a request across log lines. */
export function requestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
