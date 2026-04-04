// ─── Soul Mapping ─────────────────────────────────────────────────────────────
// Maps wmux AgentPreset IDs to agency-agents GitHub repo file paths.
// Source: https://github.com/msitarzewski/agency-agents

import type { AgentPreset } from '../types';

/**
 * Partial mapping from wmux preset IDs to agency-agents repo markdown paths.
 * Presets without a mapping simply use their base persona (no SOUL enrichment).
 */
export const SOUL_MAPPING: Partial<Record<AgentPreset, string>> = {
  // Engineering
  'software-architect': 'engineering/engineering-software-architect.md',
  'backend-architect': 'engineering/engineering-backend-architect.md',
  'frontend-developer': 'engineering/engineering-frontend-developer.md',
  'senior-developer': 'engineering/engineering-senior-developer.md',
  'ai-engineer': 'engineering/engineering-ai-engineer.md',
  'data-engineer': 'engineering/engineering-data-engineer.md',
  'database-optimizer': 'engineering/engineering-database-optimizer.md',
  'devops-automator': 'engineering/engineering-devops-automator.md',
  'sre': 'engineering/engineering-sre.md',
  'security-engineer': 'engineering/engineering-security-engineer.md',
  'code-reviewer': 'engineering/engineering-code-reviewer.md',
  'technical-writer': 'engineering/engineering-technical-writer.md',
  'devops-engineer': 'engineering/engineering-devops-automator.md',

  // Design
  'ui-designer': 'design/design-ui-designer.md',
  'ux-architect': 'design/design-ux-architect.md',
  'ux-researcher': 'design/design-ux-researcher.md',
  'brand-guardian': 'design/design-brand-guardian.md',
  'visual-storyteller': 'design/design-visual-storyteller.md',
  'image-prompt-engineer': 'design/design-image-prompt-engineer.md',

  // Project Management
  'studio-producer': 'project-management/project-management-studio-producer.md',
  'project-shepherd': 'project-management/project-management-project-shepherd.md',
  'studio-operations': 'project-management/project-management-studio-operations.md',
  'senior-project-manager': 'project-management/project-manager-senior.md',
  'experiment-tracker': 'project-management/project-management-experiment-tracker.md',
  'project-manager': 'product/product-manager.md',

  // Testing
  'accessibility-auditor': 'testing/testing-accessibility-auditor.md',
  'api-tester': 'testing/testing-api-tester.md',
  'performance-benchmarker': 'testing/testing-performance-benchmarker.md',
  'test-results-analyzer': 'testing/testing-test-results-analyzer.md',
  'workflow-optimizer': 'testing/testing-workflow-optimizer.md',
  'reality-checker': 'testing/testing-reality-checker.md',

  // Sales
  'sales-coach': 'sales/sales-coach.md',
  'account-strategist': 'sales/sales-account-strategist.md',
  'deal-strategist': 'sales/sales-deal-strategist.md',
  'outbound-strategist': 'sales/sales-outbound-strategist.md',
  'pipeline-analyst': 'sales/sales-pipeline-analyst.md',
  'sales-engineer': 'sales/sales-engineer.md',

  // Marketing
  'seo-specialist': 'marketing/marketing-seo-specialist.md',
  'content-creator': 'marketing/marketing-content-creator.md',
  'growth-hacker': 'marketing/marketing-growth-hacker.md',
  'podcast-strategist': 'marketing/marketing-podcast-strategist.md',
  'linkedin-strategist': 'marketing/marketing-linkedin-content-creator.md',
  'tiktok-strategist': 'marketing/marketing-tiktok-strategist.md',

  // Product
  'product-manager': 'product/product-manager.md',
  'feedback-synthesizer': 'product/product-feedback-synthesizer.md',

  // Specialized
  'agents-orchestrator': 'specialized/agents-orchestrator.md',
  'workflow-architect': 'specialized/specialized-workflow-architect.md',
  'mcp-builder': 'specialized/specialized-mcp-builder.md',
  'compliance-auditor': 'specialized/compliance-auditor.md',
  'developer-advocate': 'specialized/specialized-developer-advocate.md',
  'recruitment-specialist': 'specialized/recruitment-specialist.md',
};
