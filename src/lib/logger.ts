/**
 * Structured JSON logger for Workers Logs. One line per event, never throws,
 * and scrubs anything that looks like a secret or personal data.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|otp|code|session|mfa|recovery|email|phone|ip(_?hash)?$|^ip$|body|message/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;
const MAX_STRING = 300;
const MAX_DEPTH = 4;

export function scrubString(value: string): string {
  return value
    .replace(EMAIL, '[email]')
    .replace(BEARER, '$1 [redacted]')
    .replace(LONG_TOKEN, '[redacted]')
    .slice(0, MAX_STRING);
}

export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name };
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}

export type LogSink = (line: string) => void;
export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  opts: { minLevel?: LogLevel; base?: Record<string, unknown>; sink?: Record<LogLevel, LogSink> } = {},
): Logger {
  const min = ORDER[opts.minLevel ?? 'info'];
  const sink: Record<LogLevel, LogSink> = opts.sink ?? {
    debug: (l) => console.log(l),
    info: (l) => console.log(l),
    warn: (l) => console.warn(l),
    error: (l) => console.error(l),
  };
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    try {
      sink[level](
        JSON.stringify({
          level,
          event,
          ts: new Date().toISOString(),
          ...(scrub(opts.base ?? {}) as object),
          ...(scrub(fields ?? {}) as object),
        }),
      );
    } catch {
      /* Logging must never break a request. */
    }
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

export function loggerFor(env: { LOG_LEVEL?: LogLevel | undefined; APP_ENV?: string }, base: Record<string, unknown> = {}): Logger {
  return createLogger({
    minLevel: env.LOG_LEVEL ?? (env.APP_ENV === 'dev' ? 'debug' : 'info'),
    base: { env: env.APP_ENV, ...base },
  });
}
