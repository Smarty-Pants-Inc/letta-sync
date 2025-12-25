/**
 * JSON logging with secret redaction for Letta API client
 *
 * Security requirements:
 * - Never log API keys, tokens, or other secrets in plaintext
 * - Redact sensitive headers (Authorization, X-Api-Key)
 * - Support structured JSON logging for CI/automation
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Log levels in order of severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log entry
 */
export interface LogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Additional context data */
  context?: Record<string, unknown>;
  /** Error details (if applicable) */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level?: LogLevel;
  /** Output as JSON (default: false for human-readable) */
  json?: boolean;
  /** Include timestamps (default: true) */
  timestamps?: boolean;
  /** Pretty print JSON (default: false) */
  prettyPrint?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Patterns to identify sensitive values for redaction
 */
const SENSITIVE_PATTERNS = [
  // API keys (various formats)
  /sk-[a-zA-Z0-9]{20,}/g,
  /pk-[a-zA-Z0-9]{20,}/g,
  /api[_-]?key[_-]?[a-zA-Z0-9]{10,}/gi,

  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._-]+/gi,

  // JWT tokens
  /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,

  // Generic secrets
  /secret[_-]?[a-zA-Z0-9]{10,}/gi,
  /token[_-]?[a-zA-Z0-9]{10,}/gi,

  // Age encryption keys
  /AGE-SECRET-KEY-[A-Z0-9]+/g,

  // Refresh tokens
  /rt-[a-zA-Z0-9]{20,}/g,
];

/**
 * Header names that should have their values redacted
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

/**
 * Object keys that should have their values redacted
 */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'apiKey',
  'password',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'accessToken',
  'refreshtoken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'auth',
  'credentials',
  'private_key',
  'privateKey',
]);

/**
 * Log level numeric values for comparison
 */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// =============================================================================
// Redaction Functions
// =============================================================================

/**
 * Redact a potentially sensitive string value
 * Shows first 4 and last 4 characters for debugging
 *
 * @example
 * redactString('sk-abc123xyz789') // 'sk-a...9789'
 * redactString('short') // '[REDACTED]'
 */
export function redactString(value: string): string {
  if (!value || value.length < 10) {
    return '[REDACTED]';
  }
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

/**
 * Apply pattern-based redaction to a string
 */
export function redactPatterns(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => redactString(match));
  }
  return result;
}

/**
 * Redact sensitive values in an object (deep clone with redaction)
 */
export function redactObject<T>(obj: T, depth = 0): T {
  // Prevent infinite recursion
  if (depth > 10) {
    return '[MAX_DEPTH]' as unknown as T;
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitive types
  if (typeof obj === 'string') {
    return redactPatterns(obj) as unknown as T;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, depth + 1)) as unknown as T;
  }

  // Handle objects
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();

    // Check if this key should be redacted
    if (SENSITIVE_KEYS.has(lowerKey) || SENSITIVE_HEADERS.has(lowerKey)) {
      if (typeof value === 'string' && value.length > 0) {
        result[key] = redactString(value);
      } else if (value !== null && value !== undefined) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = value;
      }
    } else {
      result[key] = redactObject(value, depth + 1);
    }
  }

  return result as T;
}

/**
 * Redact sensitive headers from a Headers object or plain object
 */
export function redactHeaders(
  headers: Headers | Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};

  const entries: [string, string][] =
    headers instanceof Headers
      ? Array.from((headers as any).entries())
      : Object.entries(headers);

  for (const [key, value] of entries) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lowerKey)) {
      result[key] = redactString(value);
    } else {
      result[key] = redactPatterns(value);
    }
  }

  return result;
}

// =============================================================================
// Logger Class
// =============================================================================

/**
 * Secure logger with JSON output and automatic secret redaction
 */
export class ApiLogger {
  private config: Required<LoggerConfig>;

  constructor(config: LoggerConfig = {}) {
    this.config = {
      level: config.level ?? 'info',
      json: config.json ?? false,
      timestamps: config.timestamps ?? true,
      prettyPrint: config.prettyPrint ?? false,
    };
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.config.level];
  }

  /**
   * Create a log entry
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactPatterns(message),
    };

    if (context) {
      entry.context = redactObject(context);
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: redactPatterns(error.message),
        stack: error.stack ? redactPatterns(error.stack) : undefined,
      };
    }

    return entry;
  }

  /**
   * Format entry for output
   */
  private formatEntry(entry: LogEntry): string {
    if (this.config.json) {
      return this.config.prettyPrint
        ? JSON.stringify(entry, null, 2)
        : JSON.stringify(entry);
    }

    // Human-readable format
    const parts: string[] = [];

    if (this.config.timestamps) {
      parts.push(`[${entry.timestamp}]`);
    }

    parts.push(`[${entry.level.toUpperCase()}]`);
    parts.push(entry.message);

    if (entry.context && Object.keys(entry.context).length > 0) {
      parts.push(JSON.stringify(entry.context));
    }

    if (entry.error) {
      parts.push(`\n  Error: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) {
        parts.push(`\n  ${entry.error.stack}`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Output a log entry
   */
  private output(level: LogLevel, entry: LogEntry): void {
    const formatted = this.formatEntry(entry);

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  /**
   * Log at debug level
   */
  debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('debug')) return;
    const entry = this.createEntry('debug', message, context);
    this.output('debug', entry);
  }

  /**
   * Log at info level
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('info')) return;
    const entry = this.createEntry('info', message, context);
    this.output('info', entry);
  }

  /**
   * Log at warn level
   */
  warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog('warn')) return;
    const entry = this.createEntry('warn', message, context);
    this.output('warn', entry);
  }

  /**
   * Log at error level
   */
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    if (!this.shouldLog('error')) return;
    const entry = this.createEntry('error', message, context, error);
    this.output('error', entry);
  }

  /**
   * Log an HTTP request (with redacted sensitive data)
   */
  request(
    method: string,
    url: string,
    options?: {
      headers?: Headers | Record<string, string>;
      body?: unknown;
    }
  ): void {
    this.debug('HTTP Request', {
      method,
      url: redactPatterns(url),
      headers: options?.headers ? redactHeaders(options.headers) : undefined,
      body: options?.body ? redactObject(options.body) : undefined,
    });
  }

  /**
   * Log an HTTP response (with redacted sensitive data)
   */
  response(
    status: number,
    url: string,
    options?: {
      headers?: Headers | Record<string, string>;
      body?: unknown;
      durationMs?: number;
    }
  ): void {
    const level: LogLevel = status >= 400 ? 'warn' : 'debug';
    const entry = this.createEntry(level, `HTTP Response ${status}: ${url}`, {
      status,
      durationMs: options?.durationMs,
      headers: options?.headers ? redactHeaders(options.headers) : undefined,
      body: options?.body ? redactObject(options.body) : undefined,
    });

    if (this.shouldLog(level)) {
      this.output(level, entry);
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): ApiLogger {
    const childLogger = new ApiLogger(this.config);
    const redactedContext = redactObject(context);

    // Override methods to include context
    const originalDebug = childLogger.debug.bind(childLogger);
    const originalInfo = childLogger.info.bind(childLogger);
    const originalWarn = childLogger.warn.bind(childLogger);
    const originalError = childLogger.error.bind(childLogger);

    childLogger.debug = (msg, ctx) =>
      originalDebug(msg, { ...redactedContext, ...ctx });
    childLogger.info = (msg, ctx) =>
      originalInfo(msg, { ...redactedContext, ...ctx });
    childLogger.warn = (msg, ctx) =>
      originalWarn(msg, { ...redactedContext, ...ctx });
    childLogger.error = (msg, err, ctx) =>
      originalError(msg, err, { ...redactedContext, ...ctx });

    return childLogger;
  }

  /**
   * Update logger configuration
   */
  setConfig(config: Partial<LoggerConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<LoggerConfig> {
    return { ...this.config };
  }
}

// =============================================================================
// Default Logger Instance
// =============================================================================

/**
 * Default logger instance for the API client
 */
export const logger = new ApiLogger({
  level: process.env.SMARTY_LOG_LEVEL as LogLevel | undefined,
  json: process.env.SMARTY_LOG_JSON === 'true',
});

/**
 * Create a new logger with custom configuration
 */
export function createLogger(config: LoggerConfig = {}): ApiLogger {
  return new ApiLogger(config);
}
