/**
 * Agent pinning utilities
 * 
 * Manages the "lastAgent" setting in .letta/settings.local.json
 * This allows per-worktree agent pinning for multi-lane development.
 * 
 * Usage:
 * - Pin an agent: Associates an agent ID with the current project/worktree
 * - Unpin: Removes the association, allowing letta-code to auto-select
 * - Get pinned: Returns the currently pinned agent ID (if any)
 */

import { resolve } from 'node:path';
import {
  loadProjectSettings,
  updateProjectSettings,
  projectSettingsExist,
  getProjectSettingsPath,
  type ProjectSettings,
} from './settings.js';
import { findGitRoot, isWorktree, getMainRepoPath } from './git.js';

/**
 * Result of a pinning operation
 */
export interface PinResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The agent ID that was pinned/unpinned */
  agentId: string | null;
  /** The directory where the pin was applied */
  directory: string;
  /** Whether this is a worktree (vs main repo) */
  isWorktree: boolean;
  /** Previous agent ID (if any) */
  previousAgentId: string | null;
  /** Human-readable message */
  message: string;
}

/**
 * Options for pinning operations
 */
export interface PinOptions {
  /** Directory to pin in (defaults to cwd, uses git root if in a repo) */
  cwd?: string;
  /** If true, operate on the worktree even if it's different from main repo */
  useWorktreeRoot?: boolean;
}

/**
 * Resolve the target directory for pinning operations
 * 
 * By default, uses the git repository root (or worktree root).
 * This ensures the .letta directory is at the project root.
 * 
 * @param options - Pin options
 * @returns Resolved directory path
 */
function resolveTargetDir(options: PinOptions = {}): {
  directory: string;
  isWorktree: boolean;
} {
  const { cwd, useWorktreeRoot = true } = options;
  const startDir = cwd ?? process.cwd();
  
  try {
    const gitRoot = findGitRoot(startDir);
    const isWt = isWorktree(gitRoot);
    
    // If useWorktreeRoot is true (default), use the worktree/repo root
    // Otherwise, use the main repo path
    const directory = useWorktreeRoot ? gitRoot : getMainRepoPath(gitRoot);
    
    return { directory: resolve(directory), isWorktree: isWt };
  } catch {
    // Not in a git repo - use the provided cwd or process.cwd()
    return { directory: resolve(startDir), isWorktree: false };
  }
}

/**
 * Pin an agent ID to the current project/worktree
 * 
 * This sets the `lastAgent` field in .letta/settings.local.json,
 * which letta-code will use to select the agent on startup.
 * 
 * @param agentId - The agent ID to pin
 * @param options - Pin options
 * @returns Result of the operation
 */
export function pinAgent(agentId: string, options: PinOptions = {}): PinResult {
  const { directory, isWorktree: isWt } = resolveTargetDir(options);
  
  // Get current pinned agent (if any)
  const currentSettings = loadProjectSettings(directory);
  const previousAgentId = currentSettings?.lastAgent ?? null;
  
  // Update settings with new agent
  updateProjectSettings({ lastAgent: agentId }, directory);
  
  const action = previousAgentId ? 'Updated pin' : 'Pinned agent';
  const worktreeNote = isWt ? ' (worktree)' : '';
  
  return {
    success: true,
    agentId,
    directory,
    isWorktree: isWt,
    previousAgentId,
    message: `${action} to ${agentId} in ${directory}${worktreeNote}`,
  };
}

/**
 * Unpin the current agent from the project/worktree
 * 
 * This sets `lastAgent` to null, allowing letta-code to auto-select.
 * 
 * @param options - Pin options
 * @returns Result of the operation
 */
export function unpinAgent(options: PinOptions = {}): PinResult {
  const { directory, isWorktree: isWt } = resolveTargetDir(options);
  
  // Get current pinned agent
  const currentSettings = loadProjectSettings(directory);
  const previousAgentId = currentSettings?.lastAgent ?? null;
  
  if (!previousAgentId) {
    return {
      success: true,
      agentId: null,
      directory,
      isWorktree: isWt,
      previousAgentId: null,
      message: `No agent was pinned in ${directory}`,
    };
  }
  
  // Clear the pinned agent
  updateProjectSettings({ lastAgent: null }, directory);
  
  const worktreeNote = isWt ? ' (worktree)' : '';
  
  return {
    success: true,
    agentId: null,
    directory,
    isWorktree: isWt,
    previousAgentId,
    message: `Unpinned agent ${previousAgentId} from ${directory}${worktreeNote}`,
  };
}

/**
 * Get the currently pinned agent ID
 * 
 * @param options - Pin options
 * @returns The pinned agent ID or null if none
 */
export function getPinnedAgent(options: PinOptions = {}): string | null {
  const { directory } = resolveTargetDir(options);
  const settings = loadProjectSettings(directory);
  return settings?.lastAgent ?? null;
}

/**
 * Get detailed information about the current pin state
 * 
 * @param options - Pin options
 * @returns Detailed pin state information
 */
export function getPinState(options: PinOptions = {}): {
  agentId: string | null;
  directory: string;
  isWorktree: boolean;
  settingsPath: string;
  settingsExist: boolean;
  settings: ProjectSettings | null;
} {
  const { directory, isWorktree: isWt } = resolveTargetDir(options);
  const settings = loadProjectSettings(directory);
  
  return {
    agentId: settings?.lastAgent ?? null,
    directory,
    isWorktree: isWt,
    settingsPath: getProjectSettingsPath(directory),
    settingsExist: projectSettingsExist(directory),
    settings,
  };
}

/**
 * Check if an agent is pinned in the current directory
 * 
 * @param agentId - Optional specific agent ID to check for
 * @param options - Pin options
 * @returns true if an agent (or the specific agent) is pinned
 */
export function isPinned(agentId?: string, options: PinOptions = {}): boolean {
  const pinnedId = getPinnedAgent(options);
  
  if (agentId) {
    return pinnedId === agentId;
  }
  
  return pinnedId !== null;
}
