/**
 * Git repository detection utilities
 * Handles finding git repo roots, worktrees, and remotes
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  NotInGitRepoError,
  GitNotAvailableError,
  GitCommandError,
} from './errors.js';

/**
 * Information about a git repository
 */
export interface GitRepoInfo {
  /** Absolute path to the repository root (.git directory location) */
  root: string;
  /** Whether this is a worktree rather than the main repo */
  isWorktree: boolean;
  /** Path to the main repository (same as root if not a worktree) */
  mainRepoPath: string;
  /** Remote URL (usually origin) if available */
  remoteUrl?: string;
  /** Current branch name if available */
  currentBranch?: string;
}

/**
 * Execute a git command and return stdout
 * @throws GitCommandError if the command fails
 * @throws GitNotAvailableError if git is not installed
 */
function execGit(args: string[], cwd?: string): string {
  const command = `git ${args.join(' ')}`;
  try {
    const result = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (error: unknown) {
    // Check if git is not found
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new GitNotAvailableError();
    }

    // Handle git command errors
    const err = error as {
      status?: number;
      stderr?: Buffer | string;
    };
    const stderr =
      typeof err.stderr === 'string'
        ? err.stderr
        : err.stderr?.toString('utf-8');
    throw new GitCommandError(command, stderr, err.status ?? undefined);
  }
}

/**
 * Check if git is available on the system
 */
export function isGitAvailable(): boolean {
  try {
    execGit(['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the git repository root from a given path
 * Works with both regular repositories and worktrees
 *
 * @param startPath - Path to start searching from (defaults to cwd)
 * @returns Absolute path to the repository root
 * @throws NotInGitRepoError if not inside a git repository
 * @throws GitNotAvailableError if git is not installed
 */
export function findGitRoot(startPath?: string): string {
  const cwd = startPath ?? process.cwd();

  try {
    const root = execGit(['rev-parse', '--show-toplevel'], cwd);
    return resolve(root);
  } catch (error) {
    if (error instanceof GitNotAvailableError) {
      throw error;
    }
    throw new NotInGitRepoError(cwd);
  }
}

/**
 * Get the path to the main repository for a worktree
 * If the path is not a worktree, returns the same path
 *
 * @param repoPath - Path to the repository or worktree
 * @returns Path to the main repository
 */
export function getMainRepoPath(repoPath: string): string {
  const gitDir = join(repoPath, '.git');

  // If .git is a file, this is a worktree
  if (existsSync(gitDir)) {
    try {
      const content = readFileSync(gitDir, 'utf-8').trim();

      // Worktree .git files contain: gitdir: /path/to/main/.git/worktrees/name
      if (content.startsWith('gitdir:')) {
        const worktreeGitDir = content.slice('gitdir:'.length).trim();

        // The main repo is the parent of .git/worktrees
        // worktreeGitDir looks like: /main/repo/.git/worktrees/branch-name
        const worktreesIndex = worktreeGitDir.indexOf('/.git/worktrees/');
        if (worktreesIndex !== -1) {
          return resolve(worktreeGitDir.slice(0, worktreesIndex));
        }
      }
    } catch {
      // If we can't read the file, assume it's the main repo
    }
  }

  // Not a worktree, return the original path
  return resolve(repoPath);
}

/**
 * Check if a path is a git worktree
 *
 * @param repoPath - Path to check
 * @returns true if the path is a worktree, false otherwise
 */
export function isWorktree(repoPath: string): boolean {
  const gitPath = join(repoPath, '.git');

  try {
    const content = readFileSync(gitPath, 'utf-8').trim();
    return content.startsWith('gitdir:');
  } catch {
    return false;
  }
}

/**
 * Get the remote URL for a repository
 * Tries 'origin' first, then falls back to the first remote
 *
 * @param repoPath - Path to the repository
 * @returns Remote URL or undefined if no remotes configured
 */
export function getRemoteUrl(repoPath: string): string | undefined {
  try {
    // Try to get the origin remote first
    return execGit(['remote', 'get-url', 'origin'], repoPath);
  } catch {
    try {
      // Fall back to the first remote
      const remotes = execGit(['remote'], repoPath);
      const firstRemote = remotes.split('\n')[0];
      if (firstRemote) {
        return execGit(['remote', 'get-url', firstRemote], repoPath);
      }
    } catch {
      // No remotes configured
    }
    return undefined;
  }
}

/**
 * Get the current branch name
 *
 * @param repoPath - Path to the repository
 * @returns Branch name or undefined if detached HEAD or error
 */
export function getCurrentBranch(repoPath: string): string | undefined {
  try {
    return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a remote URL for comparison
 * Handles SSH vs HTTPS, trailing .git, etc.
 *
 * @param url - Remote URL to normalize
 * @returns Normalized URL string
 */
export function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim().toLowerCase();

  // Convert SSH URLs to a common format
  // git@github.com:user/repo.git -> github.com/user/repo
  const sshMatch = normalized.match(
    /^git@([^:]+):(.+?)(?:\.git)?$/
  );
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Convert HTTPS URLs to a common format
  // https://github.com/user/repo.git -> github.com/user/repo
  const httpsMatch = normalized.match(
    /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    normalized = `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  return normalized;
}

/**
 * Get comprehensive information about a git repository
 *
 * @param startPath - Path to start searching from (defaults to cwd)
 * @returns GitRepoInfo object with repository details
 * @throws NotInGitRepoError if not inside a git repository
 * @throws GitNotAvailableError if git is not installed
 */
export function getGitRepoInfo(startPath?: string): GitRepoInfo {
  const root = findGitRoot(startPath);
  const isWt = isWorktree(root);
  const mainRepoPath = isWt ? getMainRepoPath(root) : root;
  const remoteUrl = getRemoteUrl(mainRepoPath);
  const currentBranch = getCurrentBranch(root);

  return {
    root,
    isWorktree: isWt,
    mainRepoPath,
    remoteUrl,
    currentBranch,
  };
}
