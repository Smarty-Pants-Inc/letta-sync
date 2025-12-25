/**
 * Letta API client module
 *
 * Provides:
 * - LettaClient with blocks, identities, tools, agents sub-clients
 * - Retry logic with exponential backoff
 * - JSON logging with secret redaction
 * - Full type definitions for API entities
 */

// Main client
export { createClient } from './client.js';

export type {
  LettaClient,
  BlocksClient,
  IdentitiesClient,
  ToolsClient,
  AgentsClient,
  ListBlocksOptions,
  ListIdentitiesOptions,
  ListToolsOptions,
  ListAgentsOptions,
  UpdateIdentityRequest,
  UpdateToolRequest,
} from './client.js';

// Retry utilities
export {
  withRetry,
  createRetryable,
  withRetryAll,
  withRetrySequential,
  ApiRequestError,
  calculateDelay,
  isRetryableError,
  parseRetryAfter,
  handleRateLimit,
  sleep,
  DEFAULT_RETRY_CONFIG,
  RATE_LIMIT_STATUS,
  SERVER_ERROR_THRESHOLD,
} from './retry.js';

export type { RetryOptions, RateLimitOptions } from './retry.js';

// Logger utilities
export {
  logger,
  createLogger,
  ApiLogger,
  redactString,
  redactPatterns,
  redactObject,
  redactHeaders,
} from './logger.js';

export type { LogLevel, LogEntry, LoggerConfig } from './logger.js';

// Types
export type {
  // Common
  PaginationParams,
  ApiError,
  AuthErrorCode,
  AuthError,
  HttpMethod,
  RequestConfig,
  ApiResponse,

  // Entities
  Block,
  CreateBlockRequest,
  UpdateBlockRequest,
  Identity,
  IdentityProperty,
  CreateIdentityRequest,
  Tool,
  CreateToolRequest,
  AgentState,
  Folder,
  CreateFolderRequest,
  FileMetadata,
  FileProcessingStatus,
  MCPServer,

  // Config
  LettaClientConfig,
  LettaSettings,
  RetryConfig,
  RetryResult,
} from './types.js';
