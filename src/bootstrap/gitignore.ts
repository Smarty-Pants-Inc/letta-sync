/**
 * Gitignore utilities for ensuring local settings are not committed
 * 
 * The .letta/settings.local.json file should never be committed as it
 * contains machine-specific agent pinning.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findGitRoot } from './git.js';

/**
 * Pattern to match .letta/settings.local.json in .gitignore
 * We use the glob pattern that works for any subdirectory
 */
const SETTINGS_IGNORE_PATTERN = '.letta/settings.local.json';
const SETTINGS_GLOB_PATTERN = '**/.letta/settings.local.json';

/**
 * Result of a gitignore check or update operation
 */
export interface GitignoreResult {
  /** Whether the pattern is present in .gitignore */
  isIgnored: boolean;
  /** Path to the .gitignore file */
  gitignorePath: string;
  /** Whether .gitignore file exists */
  gitignoreExists: boolean;
  /** The pattern that was found or added */
  pattern: string;
  /** Human-readable message */
  message: string;
}

/**
 * Options for gitignore operations
 */
export interface GitignoreOptions {
  /** Directory to check (defaults to git root) */
  cwd?: string;
  /** Use glob pattern (star-star-slash) instead of simple pattern */
  useGlobPattern?: boolean;
}

/**
 * Get the path to .gitignore in the repository root
 * 
 * @param options - Gitignore options
 * @returns Path to .gitignore
 * @throws If not in a git repository
 */
function getGitignorePath(options: GitignoreOptions = {}): string {
  const { cwd } = options;
  const gitRoot = findGitRoot(cwd);
  return join(gitRoot, '.gitignore');
}

/**
 * Check if a pattern exists in .gitignore (exact or equivalent match)
 * 
 * @param content - The .gitignore content
 * @param pattern - The pattern to check for
 * @returns true if the pattern is covered
 */
function hasPattern(content: string, pattern: string): boolean {
  const lines = content.split('\n').map(line => line.trim());
  
  // Check for exact match
  if (lines.includes(pattern)) {
    return true;
  }
  
  // Check for glob pattern that covers our file
  if (lines.includes(SETTINGS_GLOB_PATTERN)) {
    return true;
  }
  
  // Check for simple pattern
  if (lines.includes(SETTINGS_IGNORE_PATTERN)) {
    return true;
  }
  
  // Check for pattern with leading slash variants
  if (lines.includes('/' + pattern)) {
    return true;
  }
  
  return false;
}

/**
 * Check if .letta/settings.local.json is ignored in .gitignore
 * 
 * @param options - Gitignore options
 * @returns Result with ignore status
 */
export function checkGitignore(options: GitignoreOptions = {}): GitignoreResult {
  const { useGlobPattern = true } = options;
  const pattern = useGlobPattern ? SETTINGS_GLOB_PATTERN : SETTINGS_IGNORE_PATTERN;
  
  let gitignorePath: string;
  try {
    gitignorePath = getGitignorePath(options);
  } catch (error) {
    return {
      isIgnored: false,
      gitignorePath: '',
      gitignoreExists: false,
      pattern,
      message: 'Not in a git repository',
    };
  }
  
  if (!existsSync(gitignorePath)) {
    return {
      isIgnored: false,
      gitignorePath,
      gitignoreExists: false,
      pattern,
      message: '.gitignore does not exist',
    };
  }
  
  const content = readFileSync(gitignorePath, 'utf-8');
  const isIgnored = hasPattern(content, pattern);
  
  return {
    isIgnored,
    gitignorePath,
    gitignoreExists: true,
    pattern,
    message: isIgnored
      ? `${SETTINGS_IGNORE_PATTERN} is already ignored`
      : `${SETTINGS_IGNORE_PATTERN} is NOT ignored - should be added to .gitignore`,
  };
}

/**
 * Ensure .letta/settings.local.json is ignored in .gitignore
 * 
 * If the pattern is not present, it will be added to .gitignore.
 * If .gitignore doesn't exist, it will be created.
 * 
 * @param options - Gitignore options
 * @returns Result of the operation
 */
export function ensureGitignore(options: GitignoreOptions = {}): GitignoreResult {
  const { useGlobPattern = true } = options;
  const pattern = useGlobPattern ? SETTINGS_GLOB_PATTERN : SETTINGS_IGNORE_PATTERN;
  
  let gitignorePath: string;
  try {
    gitignorePath = getGitignorePath(options);
  } catch (error) {
    return {
      isIgnored: false,
      gitignorePath: '',
      gitignoreExists: false,
      pattern,
      message: 'Not in a git repository - cannot create .gitignore',
    };
  }
  
  // Check if already ignored
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (hasPattern(content, pattern)) {
      return {
        isIgnored: true,
        gitignorePath,
        gitignoreExists: true,
        pattern,
        message: `${SETTINGS_IGNORE_PATTERN} is already ignored`,
      };
    }
    
    // Append the pattern
    const suffix = content.endsWith('\n') ? '' : '\n';
    const entry = `${suffix}\n# Letta Code local settings (per-worktree agent pinning)\n${pattern}\n`;
    appendFileSync(gitignorePath, entry, 'utf-8');
    
    return {
      isIgnored: true,
      gitignorePath,
      gitignoreExists: true,
      pattern,
      message: `Added ${pattern} to .gitignore`,
    };
  }
  
  // Create new .gitignore
  const content = `# Letta Code local settings (per-worktree agent pinning)\n${pattern}\n`;
  writeFileSync(gitignorePath, content, 'utf-8');
  
  return {
    isIgnored: true,
    gitignorePath,
    gitignoreExists: true,
    pattern,
    message: `Created .gitignore with ${pattern}`,
  };
}

/**
 * Check if the settings file is safe to create/modify
 * 
 * Returns false if the file would be committed (not ignored).
 * This is a safety check before writing sensitive data.
 * 
 * @param options - Gitignore options
 * @returns true if safe to create/modify the settings file
 */
export function isSettingsFileSafe(options: GitignoreOptions = {}): boolean {
  const result = checkGitignore(options);
  return result.isIgnored || !result.gitignoreExists;
}
