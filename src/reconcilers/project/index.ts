/**
 * Project reconciler module
 *
 * Provides batch operations and reporting for project-wide
 * agent management:
 * - Agent selection and filtering
 * - Batch upgrades across multiple agents
 * - Progress tracking and reporting
 * - Aggregated statistics
 *
 * @module reconcilers/project
 */

// Re-export key types for convenience

// From select-agents
export type {
  AgentRole,
  AgentSelectionCriteria,
  SelectedAgent,
  AgentSelectionResult,
  SelectAgentsOptions,
  AgentSelectionSummary,
} from './select-agents.js';

// From batch-upgrade
export type {
  UpgradeAgentResult,
  BatchUpgradeResult,
  BatchUpgradeStats,
  ExecuteBatchUpgradeOptions,
  PlanComputer,
} from './batch-upgrade.js';

// From report
export type {
  ReportFormat,
  ReportOptions,
  FormattedReport,
  ProgressReporter,
} from './report.js';

// Re-export key functions from select-agents
export {
  selectAgents,
  selectAllManagedAgents,
  summarizeSelection,
  formatSelectionSummary,
  partitionAgents,
  getAgentIds,
  groupByChannel,
  groupByRole,
} from './select-agents.js';

// Re-export from batch-upgrade (with prefixed names to avoid conflicts)
export {
  executeBatchUpgrade,
  getFailedAgentIds as batchGetFailedAgentIds,
  getSkippedAgentIds as batchGetSkippedAgentIds,
  getUpToDateAgentIds,
  hasAgentsNeedingForce,
  getOneLinerSummary as batchGetOneLinerSummary,
} from './batch-upgrade.js';

// Re-export from report (with prefixed names to avoid conflicts)
export {
  formatHumanReport,
  formatCompactReport,
  formatJsonReport,
  generateReport,
  createConsoleProgressReporter,
  getOneLinerSummary as reportGetOneLinerSummary,
  getFailedAgentIds as reportGetFailedAgentIds,
  getSkippedAgentIds as reportGetSkippedAgentIds,
} from './report.js';
