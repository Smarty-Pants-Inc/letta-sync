/**
 * Custom error classes for project resolution
 * Provides friendly error messages for common failure scenarios
 */

/**
 * Base error class for project resolution errors
 */
export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly suggestion?: string
  ) {
    super(message);
    this.name = 'ProjectResolutionError';
  }

  /**
   * Get a user-friendly formatted error message
   */
  toUserMessage(): string {
    let msg = `Error: ${this.message}`;
    if (this.suggestion) {
      msg += `\n\nSuggestion: ${this.suggestion}`;
    }
    return msg;
  }
}

/**
 * Error thrown when the current directory is not inside a git repository
 */
export class NotInGitRepoError extends ProjectResolutionError {
  constructor(cwd: string) {
    super(
      `Not inside a git repository: ${cwd}`,
      'NOT_IN_GIT_REPO',
      'Navigate to a git repository or initialize one with `git init`'
    );
    this.name = 'NotInGitRepoError';
  }
}

/**
 * Error thrown when git is not installed or not available
 */
export class GitNotAvailableError extends ProjectResolutionError {
  constructor() {
    super(
      'Git is not installed or not available in PATH',
      'GIT_NOT_AVAILABLE',
      'Install git from https://git-scm.com/downloads'
    );
    this.name = 'GitNotAvailableError';
  }
}

/**
 * Error thrown when a repository is not registered in the project registry
 */
export class RepoNotRegisteredError extends ProjectResolutionError {
  constructor(
    repoPath: string,
    public readonly remoteUrl?: string
  ) {
    const remoteInfo = remoteUrl ? ` (remote: ${remoteUrl})` : '';
    super(
      `Repository not registered in Letta project registry: ${repoPath}${remoteInfo}`,
      'REPO_NOT_REGISTERED',
      'Register this repository with `smarty-admin register` or specify a project with --project'
    );
    this.name = 'RepoNotRegisteredError';
  }
}

/**
 * Error thrown when multiple projects match a single repository
 */
export class AmbiguousProjectError extends ProjectResolutionError {
  constructor(
    repoPath: string,
    public readonly matchingProjects: string[]
  ) {
    super(
      `Multiple Letta projects found for repository: ${repoPath}`,
      'AMBIGUOUS_PROJECT',
      `Specify which project with --project <slug>. Available: ${matchingProjects.join(', ')}`
    );
    this.name = 'AmbiguousProjectError';
  }
}

/**
 * Error thrown when the registry file cannot be read or parsed
 */
export class RegistryReadError extends ProjectResolutionError {
  constructor(
    registryPath: string,
    public readonly cause?: Error
  ) {
    super(
      `Failed to read project registry: ${registryPath}`,
      'REGISTRY_READ_ERROR',
      'Ensure the registry file exists and is valid JSON'
    );
    this.name = 'RegistryReadError';
  }
}

/**
 * Error thrown when a git command fails
 */
export class GitCommandError extends ProjectResolutionError {
  constructor(
    command: string,
    public readonly stderr?: string,
    public readonly exitCode?: number
  ) {
    const details = stderr ? `: ${stderr.trim()}` : '';
    super(
      `Git command failed: ${command}${details}`,
      'GIT_COMMAND_ERROR',
      'Check your git installation and repository state'
    );
    this.name = 'GitCommandError';
  }
}

/**
 * Type guard to check if an error is a ProjectResolutionError
 */
export function isProjectResolutionError(
  error: unknown
): error is ProjectResolutionError {
  return error instanceof ProjectResolutionError;
}

/**
 * Format any error into a user-friendly message
 */
export function formatError(error: unknown): string {
  if (isProjectResolutionError(error)) {
    return error.toUserMessage();
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
