/**
 * Minimal structured logger (no dependency). Emits one JSON line per record,
 * honoring LOG_LEVEL. Use `child()` to attach persistent context (e.g. a job id).
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const log = (recordLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[recordLevel] > threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: recordLevel,
      msg: message,
      ...base,
      ...meta,
    };
    const line = JSON.stringify(record);
    if (recordLevel === "error" || recordLevel === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };

  return {
    error: (message, meta) => log("error", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    info: (message, meta) => log("info", message, meta),
    debug: (message, meta) => log("debug", message, meta),
    child: (context) => createLogger(level, { ...base, ...context }),
  };
}
