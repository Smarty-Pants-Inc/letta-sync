/**
 * API response types for Letta API client
 *
 * These types represent the most commonly used entities in the Letta API.
 * For complete type coverage, consider using @letta-ai/letta-client SDK directly.
 */

// =============================================================================
// Common Types
// =============================================================================

/**
 * Pagination parameters for list endpoints
 */
export interface PaginationParams {
  /** Number of items to return (default varies by endpoint, typically 50) */
  limit?: number;
  /** Cursor for fetching items before this ID */
  before?: string;
  /** Cursor for fetching items after this ID */
  after?: string;
  /** Sort order: ascending or descending */
  order?: 'asc' | 'desc';
  /** Field to sort by */
  orderBy?: 'created_at' | 'name';
}

/**
 * Standard API error response
 */
export interface ApiError {
  /** HTTP status code */
  status: number;
  /** Error message from API */
  message: string;
  /** Error code for programmatic handling */
  code?: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

/**
 * Auth-specific error codes
 */
export type AuthErrorCode =
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'AUTH_FORBIDDEN';

/**
 * Authentication error with actionable suggestion
 */
export interface AuthError extends ApiError {
  code: AuthErrorCode;
  /** User-friendly suggestion for resolving the error */
  suggestion: string;
  /** Optional documentation URL */
  docsUrl?: string;
}

// =============================================================================
// Request/Response Types
// =============================================================================

/**
 * HTTP methods supported by the API
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Request configuration for API calls
 */
export interface RequestConfig {
  /** HTTP method */
  method: HttpMethod;
  /** URL path (relative to base URL) */
  path: string;
  /** Query parameters */
  params?: Record<string, string | number | boolean | undefined>;
  /** Request body (will be JSON serialized) */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Override the default timeout (ms) */
  timeout?: number;
  /** Skip retry logic for this request */
  skipRetry?: boolean;
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  /** Response data */
  data: T;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Headers;
}

// =============================================================================
// Entity Types
// =============================================================================

/**
 * Block entity - reusable memory components
 */
export interface Block {
  id: string;
  label: string;
  value: string;
  limit?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  templateName?: string;
  isTemplate?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Create block request
 */
export interface CreateBlockRequest {
  label: string;
  value: string;
  limit?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  templateName?: string;
  isTemplate?: boolean;
}

/**
 * Update block request
 */
export interface UpdateBlockRequest {
  label?: string;
  value?: string;
  limit?: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Identity entity - end-users or personas
 */
export interface Identity {
  id: string;
  name: string;
  identifierKey?: string;
  identityType?: string;
  properties?: IdentityProperty[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Identity property key-value pair
 */
export interface IdentityProperty {
  key: string;
  value: string;
}

/**
 * Create identity request
 */
export interface CreateIdentityRequest {
  name: string;
  identifierKey?: string;
  identityType?: string;
  properties?: IdentityProperty[];
  metadata?: Record<string, unknown>;
}

/**
 * Tool entity - functions that agents can invoke
 */
export interface Tool {
  id: string;
  name: string;
  description?: string;
  sourceType: string;
  sourceCode?: string;
  jsonSchema: Record<string, unknown>;
  tags?: string[];
  toolType?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Create tool request
 */
export interface CreateToolRequest {
  name: string;
  sourceType: string;
  sourceCode: string;
  jsonSchema: Record<string, unknown>;
  description?: string;
  tags?: string[];
  toolType?: string;
}

/**
 * Folder entity - data containers for files
 */
export interface Folder {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  embeddingConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Create folder request
 */
export interface CreateFolderRequest {
  name: string;
  description?: string;
  instructions?: string;
  embedding?: string;
  embeddingChunkSize?: number;
  metadata?: Record<string, unknown>;
}

/**
 * File metadata
 */
export interface FileMetadata {
  id: string;
  sourceId: string;
  fileName: string;
  originalFileName: string;
  filePath?: string;
  fileType: string;
  fileSize?: number;
  processingStatus: FileProcessingStatus;
  totalChunks?: number;
  chunksEmbedded?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * File processing status enum
 */
export type FileProcessingStatus =
  | 'PARSING'
  | 'EMBEDDING'
  | 'COMPLETED'
  | 'ERROR';

/**
 * MCP Server entity
 */
export interface MCPServer {
  id: string;
  serverName: string;
  serverType: 'stdio' | 'sse' | 'streamable_http';
  config: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Agent state (simplified)
 */
export interface AgentState {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Block IDs attached to the agent (if included in response) */
  block_ids?: string[];
}

// =============================================================================
// Client Configuration
// =============================================================================

/**
 * Letta client configuration options
 */
export interface LettaClientConfig {
  /** API key for authentication */
  apiKey?: string;
  /** Base URL for the API (defaults to https://api.letta.com) */
  baseUrl?: string;
  /** Project slug for project-scoped operations */
  project?: string;
  /** Organization slug (if applicable) */
  org?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom user agent suffix */
  userAgent?: string;
}

/**
 * Settings file structure (matches ~/.letta/settings.json)
 */
export interface LettaSettings {
  env?: {
    LETTA_API_KEY?: string;
    LETTA_BASE_URL?: string;
  };
  refreshToken?: string;
  tokenExpiresAt?: number;
  deviceId?: string;
}

// =============================================================================
// Retry Configuration
// =============================================================================

/**
 * Retry configuration options
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor (0-1) to add randomness (default: 0.1) */
  jitterFactor?: number;
  /** HTTP status codes to retry on (default: [429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
}

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The result data (if successful) */
  data?: T;
  /** The error (if failed) */
  error?: Error;
  /** Number of attempts made */
  attempts: number;
  /** Total time spent on retries (ms) */
  totalTimeMs: number;
}
