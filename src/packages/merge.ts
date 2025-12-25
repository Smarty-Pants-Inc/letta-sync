/**
 * Package merge engine for smarty-admin
 * 
 * Implements the layering and merge semantics from docs/specs/layering-semantics.md.
 * 
 * Key principles:
 * 1. Project-first precedence: Higher layers override lower layers (project > org > base)
 * 2. Explicit over implicit: Explicit declarations always win over defaults
 * 3. Additive by default: Collections merge additively unless explicitly replaced
 * 4. Deletion requires intent: Deletions must be explicitly marked, not inferred from absence
 */

import type { Layer } from '../registry/types.js';
import type {
  Package,
  Resource,
  ResourceKind,
  DesiredState,
  MergeStrategy,
  MergeConflict,
  BlockResource,
  ToolResource,
  MCPServerResource,
  TemplateResource,
  FolderResource,
  IdentityResource,
  AgentPolicyResource,
} from './types.js';
import { PackageError } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Layered resources grouped by name
 */
interface LayeredResource<T extends Resource> {
  base?: T;
  org?: T;
  project?: T;
}

/**
 * Merge options
 */
export interface MergeOptions {
  /** Fail on first conflict (default: true) */
  failFast?: boolean;
  /** Add layer tags to merged resources (default: true) */
  addLayerTags?: boolean;
}

/**
 * Merge result
 */
export interface MergeResult {
  /** Successfully merged desired state */
  desiredState: DesiredState;
  /** Warnings encountered during merge */
  warnings: string[];
}

// =============================================================================
// Default Merge Strategies
// =============================================================================

/** Default merge strategies for known fields */
const DEFAULT_MERGE_STRATEGIES: Record<string, MergeStrategy> = {
  // Tags always append (set union)
  'tags': 'append',
  // Tool/Block/Folder IDs append by default
  'tool_ids': 'append',
  'toolIds': 'append',
  'block_ids': 'append',
  'blockIds': 'append',
  'folder_ids': 'append',
  'folderIds': 'append',
  // Archive IDs append (but may violate constraint)
  'archive_ids': 'append',
  'archiveIds': 'append',
};

/** Fields that use merge-by-key strategy */
const MERGE_BY_KEY_FIELDS = new Set([
  'blocks',
  'tools',
  'folders',
  'identities',
  'policies',
]);

/** Internal merge strategy including 'auto' for default behavior */
type InternalMergeStrategy = MergeStrategy | 'auto';

// =============================================================================
// Main Merge Function
// =============================================================================

/**
 * Merge packages from all layers to produce desired state
 * 
 * @param packages - Packages from each layer
 * @param options - Merge options
 * @returns Merged desired state
 * @throws PackageError if conflicts are detected
 */
export function mergePackages(
  packages: {
    base?: Package;
    org?: Package;
    project?: Package;
  },
  options: MergeOptions = {}
): MergeResult {
  const { failFast = true, addLayerTags = true } = options;
  const warnings: string[] = [];
  const conflicts: MergeConflict[] = [];

  // Merge each resource type
  const blocks = mergeResourceList<BlockResource>(
    'Block',
    packages.base?.resources.blocks ?? [],
    packages.org?.resources.blocks ?? [],
    packages.project?.resources.blocks ?? [],
    conflicts,
    warnings
  );

  const tools = mergeResourceList<ToolResource>(
    'Tool',
    packages.base?.resources.tools ?? [],
    packages.org?.resources.tools ?? [],
    packages.project?.resources.tools ?? [],
    conflicts,
    warnings
  );

  const mcpServers = mergeResourceList<MCPServerResource>(
    'MCPServer',
    packages.base?.resources.mcpServers ?? [],
    packages.org?.resources.mcpServers ?? [],
    packages.project?.resources.mcpServers ?? [],
    conflicts,
    warnings
  );

  const templates = mergeResourceList<TemplateResource>(
    'Template',
    packages.base?.resources.templates ?? [],
    packages.org?.resources.templates ?? [],
    packages.project?.resources.templates ?? [],
    conflicts,
    warnings
  );

  const folders = mergeResourceList<FolderResource>(
    'Folder',
    packages.base?.resources.folders ?? [],
    packages.org?.resources.folders ?? [],
    packages.project?.resources.folders ?? [],
    conflicts,
    warnings
  );

  const identities = mergeResourceList<IdentityResource>(
    'Identity',
    packages.base?.resources.identities ?? [],
    packages.org?.resources.identities ?? [],
    packages.project?.resources.identities ?? [],
    conflicts,
    warnings
  );

  const policies = mergeResourceList<AgentPolicyResource>(
    'AgentPolicy',
    packages.base?.resources.policies ?? [],
    packages.org?.resources.policies ?? [],
    packages.project?.resources.policies ?? [],
    conflicts,
    warnings
  );

  // Check for conflicts
  if (conflicts.length > 0) {
    const conflictMessages = conflicts.map(c => 
      `  - ${c.type}: ${c.message}${c.suggestions ? '\n    Suggestions: ' + c.suggestions.join(', ') : ''}`
    ).join('\n');
    
    throw new PackageError(
      `Merge conflicts detected:\n${conflictMessages}`,
      'MERGE_CONFLICT',
      { conflicts }
    );
  }

  // Add layer tags if requested
  const layerTags = {
    base: '_layer:base',
    org: '_layer:org',
    project: '_layer:project',
  };

  if (addLayerTags) {
    addLayerTagsToResources(blocks, layerTags);
    addLayerTagsToResources(tools, layerTags);
    addLayerTagsToResources(templates, layerTags);
  }

  const desiredState: DesiredState = {
    blocks,
    tools,
    mcpServers,
    templates,
    folders,
    identities,
    policies,
    layerTags,
  };

  return { desiredState, warnings };
}

// =============================================================================
// Resource List Merging
// =============================================================================

/**
 * Merge a list of resources from all layers
 */
function mergeResourceList<T extends Resource>(
  resourceType: string,
  base: T[],
  org: T[],
  project: T[],
  conflicts: MergeConflict[],
  warnings: string[]
): T[] {
  // Group resources by name
  const resourceMap = new Map<string, LayeredResource<T>>();

  for (const resource of base) {
    resourceMap.set(resource.metadata.name, { base: resource });
  }

  for (const resource of org) {
    const existing = resourceMap.get(resource.metadata.name) ?? {};
    existing.org = resource;
    resourceMap.set(resource.metadata.name, existing);
  }

  for (const resource of project) {
    const existing = resourceMap.get(resource.metadata.name) ?? {};
    existing.project = resource;
    resourceMap.set(resource.metadata.name, existing);
  }

  // Merge each resource
  const mergedResources: T[] = [];

  for (const [name, layers] of resourceMap) {
    // Check for resource identity conflicts before merging
    const identityConflict = detectResourceIdentityConflict(resourceType, name, layers);
    if (identityConflict) {
      conflicts.push(identityConflict);
      continue;
    }

    // Merge the resource
    const merged = mergeResource(resourceType, name, layers, conflicts, warnings);

    // Check for deletion marker
    if (merged && !isMarkedForDeletion(merged)) {
      mergedResources.push(merged);
    } else if (merged && isMarkedForDeletion(merged)) {
      // Resource explicitly deleted - check if it existed
      if (!layers.base && !layers.org) {
        warnings.push(
          `Warning: Deletion marker for '${resourceType}.${name}' has no effect - resource not defined in any lower layer.`
        );
      }
    }
  }

  return mergedResources;
}

/**
 * Detect resource identity conflicts (incompatible definitions)
 */
function detectResourceIdentityConflict<T extends Resource>(
  resourceType: string,
  name: string,
  layers: LayeredResource<T>
): MergeConflict | null {
  const resources = [layers.base, layers.org, layers.project].filter(Boolean) as T[];
  if (resources.length < 2) {
    return null;
  }

  // Check for type conflicts in key identifying fields
  // For tools: check toolType conflicts
  if (resourceType === 'Tool') {
    const toolTypes = resources
      .map(r => (r as unknown as ToolResource).spec.toolType)
      .filter(t => t !== undefined);
    
    const uniqueTypes = new Set(toolTypes);
    if (uniqueTypes.size > 1) {
      return {
        type: 'resource_identity_conflict',
        path: `${resourceType}.${name}`,
        message: `Resource identity conflict: tool '${name}' has different toolType values in different layers`,
        layers: {
          base: (layers.base as unknown as ToolResource)?.spec.toolType,
          org: (layers.org as unknown as ToolResource)?.spec.toolType,
          project: (layers.project as unknown as ToolResource)?.spec.toolType,
        },
        suggestions: [
          'Rename one of the tools to avoid collision',
          'Use project layer to explicitly override with one definition',
          'Delete the unwanted definition using _delete: true',
        ],
      };
    }
  }

  return null;
}

/**
 * Merge a single resource from all layers
 */
function mergeResource<T extends Resource>(
  resourceType: string,
  name: string,
  layers: LayeredResource<T>,
  conflicts: MergeConflict[],
  warnings: string[]
): T | null {
  const { base, org, project } = layers;

  // If only one layer has the resource, return it
  if (!base && !org) return project ?? null;
  if (!base && !project) return org ?? null;
  if (!org && !project) return base ?? null;

  // Start with base and apply layers
  let result = base ? cloneDeep(base) : ({} as T);

  // Apply org layer
  if (org) {
    result = deepMergeResource(result, org, getMergeStrategies(org), conflicts, `${resourceType}.${name}`);
  }

  // Apply project layer
  if (project) {
    result = deepMergeResource(result, project, getMergeStrategies(project), conflicts, `${resourceType}.${name}`);
  }

  // Apply deletions (tag removals, etc.)
  result = applyDeletions(result, base, org, project, warnings);

  return result;
}

// =============================================================================
// Deep Merge Implementation
// =============================================================================

/**
 * Deep merge two resource objects
 */
function deepMergeResource<T extends Resource>(
  target: T,
  source: T,
  mergeStrategies: Record<string, InternalMergeStrategy>,
  conflicts: MergeConflict[],
  path: string
): T {
  return deepMerge(
    target as unknown as Record<string, unknown>,
    source as unknown as Record<string, unknown>,
    mergeStrategies,
    conflicts,
    path
  ) as unknown as T;
}

/**
 * Deep merge two objects
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  mergeStrategies: Record<string, InternalMergeStrategy>,
  conflicts: MergeConflict[],
  path: string
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const targetValue = target[key];
    const sourceValue = source[key];
    const fieldPath = `${path}.${key}`;

    // Skip merge metadata fields
    if (key === '_merge' || key === '_delete') {
      result[key] = sourceValue;
      continue;
    }

    // Undefined means "no opinion" - keep target
    if (sourceValue === undefined) {
      continue;
    }

    // Explicit null - override
    if (sourceValue === null) {
      result[key] = null;
      continue;
    }

    // Type conflict detection
    if (targetValue !== undefined && targetValue !== null) {
      const targetType = getValueType(targetValue);
      const sourceType = getValueType(sourceValue);
      
      if (targetType !== sourceType) {
        conflicts.push({
          type: 'type_conflict',
          path: fieldPath,
          message: `Type conflict at ${fieldPath}: expected ${targetType}, got ${sourceType}`,
          suggestions: [
            `Change value to match type: ${targetType}`,
            'Use explicit override with correct type',
          ],
        });
        continue;
      }
    }

    // Get merge strategy for this field
    const strategy: InternalMergeStrategy = mergeStrategies[key] ?? DEFAULT_MERGE_STRATEGIES[key] ?? 'auto';

    if (Array.isArray(sourceValue)) {
      result[key] = mergeArray(
        targetValue as unknown[] | undefined,
        sourceValue as unknown[],
        strategy === 'auto' ? getDefaultArrayStrategy(key) : strategy as MergeStrategy,
        key
      );
    } else if (typeof sourceValue === 'object' && sourceValue !== null) {
      result[key] = deepMerge(
        (targetValue as Record<string, unknown>) ?? {},
        sourceValue as Record<string, unknown>,
        mergeStrategies,
        conflicts,
        fieldPath
      );
    } else {
      // Scalar - last wins
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Merge arrays based on strategy
 */
function mergeArray(
  target: unknown[] | undefined,
  source: unknown[],
  strategy: MergeStrategy,
  fieldName: string
): unknown[] {
  switch (strategy) {
    case 'replace':
      return source;

    case 'append': {
      // Handle tag-like arrays with removal syntax (!item)
      const targetArray = target ?? [];
      const additions: unknown[] = [];
      const removals = new Set<string>();

      for (const item of source) {
        if (typeof item === 'string' && item.startsWith('!')) {
          removals.add(item.slice(1));
        } else {
          additions.push(item);
        }
      }

      // Combine and deduplicate (for primitive arrays)
      const combined = [...targetArray, ...additions];
      
      // Apply removals
      const filtered = combined.filter(item => {
        if (typeof item === 'string') {
          return !removals.has(item);
        }
        return true;
      });

      // Deduplicate strings (for tags)
      if (filtered.length > 0 && typeof filtered[0] === 'string') {
        return [...new Set(filtered as string[])];
      }

      return filtered;
    }

    case 'merge-by-key': {
      const result = [...(target ?? [])];
      
      for (const item of source) {
        if (typeof item !== 'object' || item === null) {
          result.push(item);
          continue;
        }

        const itemObj = item as Record<string, unknown>;
        const key = (itemObj.id ?? itemObj.name ?? itemObj.label) as string | undefined;

        if (!key) {
          result.push(item);
          continue;
        }

        // Check for deletion marker
        if (itemObj._delete === true) {
          const existingIndex = result.findIndex(r => {
            if (typeof r !== 'object' || r === null) return false;
            const rObj = r as Record<string, unknown>;
            return rObj.id === key || rObj.name === key || rObj.label === key;
          });
          if (existingIndex >= 0) {
            result.splice(existingIndex, 1);
          }
          continue;
        }

        // Find existing item by key
        const existingIndex = result.findIndex(r => {
          if (typeof r !== 'object' || r === null) return false;
          const rObj = r as Record<string, unknown>;
          return rObj.id === key || rObj.name === key || rObj.label === key;
        });

        if (existingIndex >= 0) {
          // Merge existing item
          result[existingIndex] = deepMerge(
            result[existingIndex] as Record<string, unknown>,
            itemObj,
            {},
            [],
            fieldName
          );
        } else {
          // Add new item
          result.push(item);
        }
      }

      return result;
    }

    default:
      // Auto strategy - use append for most arrays
      return mergeArray(target, source, 'append', fieldName);
  }
}

/**
 * Get default array merge strategy for a field
 */
function getDefaultArrayStrategy(fieldName: string): MergeStrategy {
  if (MERGE_BY_KEY_FIELDS.has(fieldName)) {
    return 'merge-by-key';
  }
  return 'append';
}

// =============================================================================
// Deletion Handling
// =============================================================================

/**
 * Apply deletions from all layers
 */
function applyDeletions<T extends Resource>(
  merged: T,
  base: T | undefined,
  org: T | undefined,
  project: T | undefined,
  warnings: string[]
): T {
  const result = { ...merged } as T;

  // Process deletions in order: base, org, project
  // (project deletions have final say)
  
  // Tag removal is handled in mergeArray with !prefix syntax
  // Field-level null is handled in deepMerge
  
  return result;
}

/**
 * Check if a resource is marked for deletion
 */
function isMarkedForDeletion(resource: unknown): boolean {
  if (typeof resource !== 'object' || resource === null) {
    return false;
  }
  return (resource as Record<string, unknown>)._delete === true;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get merge strategies from a resource's _merge metadata
 */
function getMergeStrategies(resource: Resource): Record<string, InternalMergeStrategy> {
  const mergeMetadata = (resource as unknown as Record<string, unknown>)._merge;
  if (!mergeMetadata || typeof mergeMetadata !== 'object') {
    return {};
  }
  return mergeMetadata as Record<string, InternalMergeStrategy>;
}

/**
 * Get the type of a value for conflict detection
 */
function getValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Deep clone an object
 */
function cloneDeep<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => cloneDeep(item)) as unknown as T;
  }

  const clone = {} as T;
  for (const key of Object.keys(obj as object)) {
    (clone as Record<string, unknown>)[key] = cloneDeep((obj as Record<string, unknown>)[key]);
  }
  return clone;
}

/**
 * Add layer tags to resources based on which layer they came from
 */
function addLayerTagsToResources<T extends Resource>(
  resources: T[],
  layerTags: { base: string; org: string; project: string }
): void {
  for (const resource of resources) {
    const spec = resource.spec as unknown as Record<string, unknown>;
    if (!spec.tags) {
      spec.tags = [];
    }
    
    const tags = spec.tags as string[];
    const layerTag = layerTags[resource.spec.layer];
    
    if (!tags.includes(layerTag)) {
      tags.push(layerTag);
    }
  }
}

// =============================================================================
// Constraint Validation
// =============================================================================

/**
 * Validate merged state against Letta API constraints
 */
export function validateConstraints(
  desiredState: DesiredState
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  // Example: Agent can have at most 1 archive
  // This would be validated when agents are present in the state
  // For now, we validate resource-level constraints

  // Tool name must match jsonSchema.function.name
  for (const tool of desiredState.tools) {
    const schemaName = tool.spec.jsonSchema?.function?.name;
    if (schemaName && schemaName !== tool.metadata.name) {
      conflicts.push({
        type: 'constraint_violation',
        path: `Tool.${tool.metadata.name}`,
        message: `Tool name '${tool.metadata.name}' does not match jsonSchema.function.name '${schemaName}'`,
        suggestions: [
          `Rename tool to '${schemaName}'`,
          `Update jsonSchema.function.name to '${tool.metadata.name}'`,
        ],
      });
    }
  }

  // Block isTemplate requires templateName
  for (const block of desiredState.blocks) {
    if (block.spec.isTemplate && !block.spec.templateName) {
      conflicts.push({
        type: 'constraint_violation',
        path: `Block.${block.metadata.name}`,
        message: `Block with isTemplate=true requires templateName`,
        suggestions: [
          'Add spec.templateName field',
          'Set spec.isTemplate to false',
        ],
      });
    }
  }

  // Folder layer restriction (not base)
  for (const folder of desiredState.folders) {
    if (folder.spec.layer === 'base') {
      conflicts.push({
        type: 'constraint_violation',
        path: `Folder.${folder.metadata.name}`,
        message: `Folder cannot have layer: base`,
        suggestions: [
          'Change layer to org or project',
        ],
      });
    }
  }

  // Identity layer restriction (not base)
  for (const identity of desiredState.identities) {
    if (identity.spec.layer === 'base') {
      conflicts.push({
        type: 'constraint_violation',
        path: `Identity.${identity.metadata.name}`,
        message: `Identity cannot have layer: base`,
        suggestions: [
          'Change layer to org or project',
        ],
      });
    }
  }

  // MCPServer must be org layer
  for (const server of desiredState.mcpServers) {
    if (server.spec.layer !== 'org') {
      conflicts.push({
        type: 'constraint_violation',
        path: `MCPServer.${server.metadata.name}`,
        message: `MCPServer must have layer: org`,
        suggestions: [
          'Change layer to org',
        ],
      });
    }
  }

  return conflicts;
}

// =============================================================================
// Exports
// =============================================================================

export { cloneDeep };
