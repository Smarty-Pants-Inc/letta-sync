/**
 * Retry logic with exponential backoff for Letta API client
 *
 * Features:
 * - Exponential backoff with configurable base delay
 * - Jitter to prevent thundering herd
 * - Rate limit handling (HTTP 429)
 * - Configurable retry conditions
 */

import type { RetryConfig, RetryResult, ApiError } from './types.js';
import { logger, type ApiLogger } from './logger.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.1,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/**
 * HTTP status codes with special handling
 */
export const RATE_LIMIT_STATUS = 429;
export const SERVER_ERROR_THRESHOLD = 500;

// =============================================================================
// Types
// =============================================================================

/**
 * Options for a retry operation
 */
export interface RetryOptions<T> extends RetryConfig {
  /** Custom logger instance */
  logger?: ApiLogger;
  /** Called before each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Custom function to determine if an error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Called when operation succeeds */
  onSuccess?: (result: T, attempts: number) => void;
  /** Called when all retries are exhausted */
  onExhausted?: (error: Error, attempts: number) => void;
}

/**
 * Error class for API errors with HTTP status
 */
export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;
  public readonly retryAfter?: number;

  constructor(
    message: string,
    status: number,
    options?: {
      code?: string;
      details?: Record<string, unknown>;
      retryAfter?: number;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
    this.retryAfter = options?.retryAfter;
    // Store cause manually for ES2021 compatibility
    if (options?.cause) {
      (this as any).cause = options.cause;
    }
  }

  /**
   * Convert to ApiError format
   */
  toApiError(): ApiError {
    return {
      status: this.status,
      message: this.message,
      code: this.code,
      details: this.details,
    };
  }

  /**
   * Check if this error is a rate limit error
   */
  isRateLimited(): boolean {
    return this.status === RATE_LIMIT_STATUS;
  }

  /**
   * Check if this error is a server error
   */
  isServerError(): boolean {
    return this.status >= SERVER_ERROR_THRESHOLD;
  }
}

// =============================================================================
// Delay Calculation
// =============================================================================

/**
 * Calculate delay for a retry attempt using exponential backoff
 *
 * @param attempt - The current attempt number (1-indexed)
 * @param config - Retry configuration
 * @param retryAfter - Optional Retry-After header value (seconds)
 * @returns Delay in milliseconds
 */
export function calculateDelay(
  attempt: number,
  config: Required<RetryConfig>,
  retryAfter?: number
): number {
  // If rate-limited with Retry-After header, use that (converted to ms)
  if (retryAfter !== undefined && retryAfter > 0) {
    // Add small jitter to Retry-After to prevent thundering herd
    const jitter = Math.random() * config.baseDelayMs * config.jitterFactor;
    return Math.min(retryAfter * 1000 + jitter, config.maxDelayMs);
  }

  // Exponential backoff: baseDelay * 2^(attempt-1)
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);

  // Add jitter to prevent thundering herd
  const jitter =
    Math.random() * exponentialDelay * config.jitterFactor * 2 -
    exponentialDelay * config.jitterFactor;

  const delayWithJitter = exponentialDelay + jitter;

  // Clamp to max delay
  return Math.min(Math.max(delayWithJitter, 0), config.maxDelayMs);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Retry Logic
// =============================================================================

/**
 * Check if an error is retryable based on configuration
 */
export function isRetryableError(
  error: Error,
  config: Required<RetryConfig>
): boolean {
  // Network errors are retryable
  if (error.name === 'TypeError' && error.message.includes('fetch')) {
    return true;
  }

  // Check for AbortError (timeout)
  if (error.name === 'AbortError') {
    return true;
  }

  // Check ApiRequestError status
  if (error instanceof ApiRequestError) {
    return config.retryableStatuses.includes(error.status);
  }

  // Check for common network error messages
  const networkErrorPatterns = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'network',
    'socket hang up',
  ];

  const message = error.message.toLowerCase();
  return networkErrorPatterns.some((pattern) =>
    message.includes(pattern.toLowerCase())
  );
}

/**
 * Parse Retry-After header value
 *
 * @param value - Header value (seconds as number or HTTP-date)
 * @returns Delay in seconds, or undefined if not parseable
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  // Try parsing as number (seconds)
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds;
  }

  // Try parsing as HTTP-date
  try {
    const date = new Date(value);
    const delayMs = date.getTime() - Date.now();
    if (delayMs > 0) {
      return Math.ceil(delayMs / 1000);
    }
  } catch {
    // Ignore parse errors
  }

  return undefined;
}

/**
 * Execute a function with retry logic
 *
 * @param fn - The function to execute
 * @param options - Retry options
 * @returns RetryResult with success/failure and metadata
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions<T> = {}
): Promise<RetryResult<T>> {
  const config = {
    ...DEFAULT_RETRY_CONFIG,
    ...options,
  };

  const log = options.logger ?? logger;
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const result = await fn();

      // Success
      const totalTimeMs = Date.now() - startTime;
      if (attempt > 1) {
        log.info(`Request succeeded after ${attempt} attempts`, {
          attempts: attempt,
          totalTimeMs,
        });
      }

      options.onSuccess?.(result, attempt);

      return {
        success: true,
        data: result,
        attempts: attempt,
        totalTimeMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const isRetryable = options.isRetryable
        ? options.isRetryable(lastError)
        : isRetryableError(lastError, config);

      const isLastAttempt = attempt > config.maxRetries;

      if (!isRetryable || isLastAttempt) {
        // Don't retry
        const totalTimeMs = Date.now() - startTime;

        if (isLastAttempt && config.maxRetries > 0) {
          log.warn(`All ${config.maxRetries} retry attempts exhausted`, {
            error: lastError.message,
            attempts: attempt,
            totalTimeMs,
          });
          options.onExhausted?.(lastError, attempt);
        } else if (!isRetryable) {
          log.debug('Error is not retryable', {
            error: lastError.message,
            attempts: attempt,
          });
        }

        return {
          success: false,
          error: lastError,
          attempts: attempt,
          totalTimeMs,
        };
      }

      // Calculate delay
      const retryAfter =
        lastError instanceof ApiRequestError
          ? lastError.retryAfter
          : undefined;

      const delayMs = calculateDelay(attempt, config, retryAfter);

      // Log retry attempt
      log.info(
        `Retry attempt ${attempt}/${config.maxRetries} in ${Math.round(delayMs)}ms`,
        {
          error: lastError.message,
          status:
            lastError instanceof ApiRequestError
              ? lastError.status
              : undefined,
          delayMs: Math.round(delayMs),
        }
      );

      options.onRetry?.(attempt, lastError, delayMs);

      // Wait before retry
      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  return {
    success: false,
    error: lastError ?? new Error('Unknown error'),
    attempts: config.maxRetries + 1,
    totalTimeMs: Date.now() - startTime,
  };
}

/**
 * Create a retryable version of a function
 *
 * @param fn - The function to wrap
 * @param options - Default retry options
 * @returns A new function that automatically retries on failure
 */
export function createRetryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions<TResult> = {}
): (...args: TArgs) => Promise<RetryResult<TResult>> {
  return async (...args: TArgs) => {
    return withRetry(() => fn(...args), options);
  };
}

/**
 * Execute multiple functions with retry, failing fast on non-retryable errors
 *
 * @param fns - Array of functions to execute
 * @param options - Retry options for each function
 * @returns Array of results
 */
export async function withRetryAll<T>(
  fns: Array<() => Promise<T>>,
  options: RetryOptions<T> = {}
): Promise<Array<RetryResult<T>>> {
  return Promise.all(fns.map((fn) => withRetry(fn, options)));
}

/**
 * Execute functions sequentially with retry, stopping on first failure
 *
 * @param fns - Array of functions to execute
 * @param options - Retry options for each function
 * @returns Array of results (stops at first failure)
 */
export async function withRetrySequential<T>(
  fns: Array<() => Promise<T>>,
  options: RetryOptions<T> = {}
): Promise<Array<RetryResult<T>>> {
  const results: Array<RetryResult<T>> = [];

  for (const fn of fns) {
    const result = await withRetry(fn, options);
    results.push(result);

    if (!result.success) {
      break;
    }
  }

  return results;
}

// =============================================================================
// Rate Limit Specific Helpers
// =============================================================================

/**
 * Options for rate limit handling
 */
export interface RateLimitOptions {
  /** Maximum time to wait for rate limit (ms) */
  maxWaitMs?: number;
  /** Logger instance */
  logger?: ApiLogger;
}

/**
 * Handle a rate limit error by waiting the specified time
 *
 * @param error - The rate limit error
 * @param options - Rate limit options
 * @returns true if we should retry, false if max wait exceeded
 */
export async function handleRateLimit(
  error: ApiRequestError,
  options: RateLimitOptions = {}
): Promise<boolean> {
  const { maxWaitMs = 60000, logger: log = logger } = options;

  if (!error.isRateLimited()) {
    return false;
  }

  const retryAfterSeconds = error.retryAfter ?? 5;
  const waitMs = retryAfterSeconds * 1000;

  if (waitMs > maxWaitMs) {
    log.warn(`Rate limit wait time (${waitMs}ms) exceeds max (${maxWaitMs}ms)`);
    return false;
  }

  log.info(`Rate limited, waiting ${retryAfterSeconds} seconds`, {
    retryAfter: retryAfterSeconds,
    waitMs,
  });

  await sleep(waitMs);
  return true;
}
