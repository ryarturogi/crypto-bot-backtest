export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${COLORS[level]}${ts} ${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}