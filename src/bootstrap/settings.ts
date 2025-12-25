/**
 * Project settings management for Letta Code compatibility
 * 
 * Manages .letta/settings.local.json which stores:
 * - lastAgent: The pinned agent ID for this project/worktree
 * - permissions: Optional permission rules (not managed by smarty-admin)
 * 
 * This format is compatible with letta-code's project settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Project settings schema (compatible with letta-code)
 */
export interface ProjectSettings {
  /** Pinned agent ID for this project */
  lastAgent: string | null;
  /** Optional permission rules (preserved but not managed) */
  permissions?: unknown;
  /** Cached shared block IDs by label (for scope sync) */
  localSharedBlockIds?: Record<string, string>;
}

/**
 * Default project settings
 */
const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  lastAgent: null,
};

/**
 * Get the .letta directory path for a given root directory
 * 
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns Absolute path to the .letta directory
 */
export function getLettaDir(rootDir?: string): string {
  const root = rootDir ? resolve(rootDir) : process.cwd();
  return join(root, '.letta');
}

/**
 * Get the project settings file path
 * 
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns Absolute path to settings.local.json
 */
export function getProjectSettingsPath(rootDir?: string): string {
  return join(getLettaDir(rootDir), 'settings.local.json');
}

/**
 * Ensure the .letta directory exists
 * 
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns Path to the created/existing .letta directory
 */
export function ensureLettaDir(rootDir?: string): string {
  const lettaDir = getLettaDir(rootDir);
  
  if (!existsSync(lettaDir)) {
    mkdirSync(lettaDir, { recursive: true });
  }
  
  return lettaDir;
}

/**
 * Load project settings from .letta/settings.local.json
 * 
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns ProjectSettings or null if file doesn't exist
 */
export function loadProjectSettings(rootDir?: string): ProjectSettings | null {
  const settingsPath = getProjectSettingsPath(rootDir);
  
  if (!existsSync(settingsPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as ProjectSettings;
    
    // Merge with defaults to ensure all fields exist
    return { ...DEFAULT_PROJECT_SETTINGS, ...settings };
  } catch (error) {
    // Log but don't throw - treat corrupted file as non-existent
    console.error(`Warning: Failed to parse project settings at ${settingsPath}:`, error);
    return null;
  }
}

/**
 * Save project settings to .letta/settings.local.json
 * Creates the .letta directory if it doesn't exist.
 * 
 * @param settings - The settings to save
 * @param rootDir - The project root directory (defaults to cwd)
 */
export function saveProjectSettings(
  settings: ProjectSettings,
  rootDir?: string
): void {
  ensureLettaDir(rootDir);
  const settingsPath = getProjectSettingsPath(rootDir);
  
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Update specific project settings fields (preserves existing values)
 * 
 * @param updates - Partial settings to merge with existing
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns The updated settings
 */
export function updateProjectSettings(
  updates: Partial<ProjectSettings>,
  rootDir?: string
): ProjectSettings {
  const currentSettings = loadProjectSettings(rootDir) ?? DEFAULT_PROJECT_SETTINGS;
  const newSettings = { ...currentSettings, ...updates };
  saveProjectSettings(newSettings, rootDir);
  return newSettings;
}

/**
 * Check if project settings file exists
 * 
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns true if settings.local.json exists
 */
export function projectSettingsExist(rootDir?: string): boolean {
  return existsSync(getProjectSettingsPath(rootDir));
}

/**
 * Delete project settings file
 * 
 * @param rootDir - The project root directory (defaults to cwd)
 * @returns true if file was deleted, false if it didn't exist
 */
export function deleteProjectSettings(rootDir?: string): boolean {
  const settingsPath = getProjectSettingsPath(rootDir);
  
  if (!existsSync(settingsPath)) {
    return false;
  }
  
  const { unlinkSync } = require('node:fs');
  unlinkSync(settingsPath);
  return true;
}
