/**
 * Minimal logger that writes to stderr only. stdout carries the MCP protocol
 * when running over stdio, so nothing else may ever be written there.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(level: LogLevel, write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  const log = (lvl: LogLevel) => (message: string) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(`${new Date().toISOString()} [elysium-mcp] ${lvl.toUpperCase()} ${message}\n`);
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
