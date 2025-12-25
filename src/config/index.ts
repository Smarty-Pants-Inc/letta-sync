/**
 * Configuration module exports
 */

export {
  resolveProject,
  parseProjectIdentifier,
  getProjectHeaders,
  requireProject,
  createProjectConfig,
  formatProject,
  validateProject,
  ProjectResolutionError,
  type ProjectResolutionResult,
  type ProjectResolveOptions,
  type ResolutionPriority,
} from './project.js';
