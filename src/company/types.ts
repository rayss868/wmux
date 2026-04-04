// === Company Mode Types ===
// Canonical definitions — re-exported from shared/types.ts for backward compatibility.

export type AgentPreset =
  // Engineering
  | 'software-architect' | 'backend-architect' | 'frontend-developer' | 'senior-developer'
  | 'ai-engineer' | 'data-engineer' | 'database-optimizer' | 'devops-automator' | 'sre'
  | 'security-engineer' | 'code-reviewer' | 'technical-writer'
  | 'database-architect' | 'security-auditor' | 'test-automator'
  | 'deployment-engineer' | 'devops-engineer'
  // Design
  | 'ui-designer' | 'ux-architect' | 'ux-researcher'
  | 'brand-guardian' | 'visual-storyteller' | 'image-prompt-engineer'
  | 'design-system-architect'
  // Project Management
  | 'studio-producer' | 'project-shepherd' | 'studio-operations'
  | 'senior-project-manager' | 'experiment-tracker'
  | 'project-manager'
  // Testing
  | 'accessibility-auditor' | 'api-tester' | 'performance-benchmarker'
  | 'test-results-analyzer' | 'workflow-optimizer' | 'reality-checker'
  // Sales
  | 'sales-coach' | 'account-strategist' | 'deal-strategist'
  | 'outbound-strategist' | 'pipeline-analyst' | 'sales-engineer'
  // Marketing
  | 'seo-specialist' | 'content-creator' | 'growth-hacker'
  | 'podcast-strategist' | 'linkedin-strategist' | 'tiktok-strategist'
  | 'content-strategist' | 'social-media-manager'
  // Product
  | 'product-manager' | 'feedback-synthesizer' | 'feature-prioritizer' | 'roadmap-strategist'
  // Specialized
  | 'agents-orchestrator' | 'workflow-architect' | 'mcp-builder'
  | 'compliance-auditor' | 'developer-advocate' | 'recruitment-specialist'
  // Custom
  | 'custom';

export type MemberStatus = 'idle' | 'running' | 'complete' | 'error' | 'waiting' | 'stuck' | 'pooled';

export interface TeamMember {
  id: string;
  name: string;
  preset: AgentPreset;
  customAgentPath?: string;
  workspaceId: string;
  ptyId?: string;
  status: MemberStatus;
  lastMessage?: string;
  lastActivity?: number;
  assignedTaskId?: string;
  originalDeptId?: string;
  turnCount?: number;
  lastCompactedAt?: number;
}

export interface Department {
  id: string;
  name: string;
  leadId: string;
  members: TeamMember[];
  worktreeBranch?: string;
  maxConcurrentPerDept?: number;
}

export interface WorkUnit {
  id: string;
  assigneeId: string;
  branch?: string;
  ownedFiles: string[];
  forbiddenFiles: string[];
  interfaceContracts?: InterfaceContract[];
  dependsOn: string[];
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
}

export interface InterfaceContract {
  symbol: string;
  file: string;
  typeSignature?: string;
  fromUnitId?: string;
}

export interface CompactionSnapshot {
  memberId: string;
  memberName: string;
  role: string;
  currentTask?: string;
  decisions: string[];
  modifiedFiles: string[];
  pendingInbox: number;
  timestamp: number;
}

export interface Company {
  id: string;
  name: string;
  ceoWorkspaceId?: string;
  departments: Department[];
  createdAt: number;
  totalCostEstimate?: number;
  skipPermissions?: boolean;
  workDir?: string;
}

// Company Templates
export interface CompanyTemplateMember {
  name: string;
  preset: AgentPreset;
  customAgentPath?: string;
}

export interface CompanyTemplateDepartment {
  name: string;
  leadName: string;
  leadPrompt?: string;
  worktreeBranch?: string;
  members: CompanyTemplateMember[];
}

export interface CompanyTemplate {
  name: string;
  ceo?: { prompt?: string };
  departments: CompanyTemplateDepartment[];
}

// Worktree Info
export interface WorktreeInfo {
  worktree: string;
  HEAD: string;
  branch: string;
  bare?: boolean;
}

// Risk Level & Approval
export type RiskLevel = 'safe' | 'review' | 'critical';

export interface ApprovalRequest {
  id: string;
  ptyId: string;
  memberId: string;
  memberName: string;
  departmentName: string;
  action: string;
  riskLevel: RiskLevel;
  timestamp: number;
}

// Message Routing
export interface MessageRouteEvent {
  from: string;
  to: string;
  message: string;
  priority: 'low' | 'normal' | 'high';
  isBroadcast: boolean;
}

// A2A Inbox
export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  message: string;
  priority: string;
  timestamp: number;
  read: boolean;
}

export const MAX_INBOX_SIZE = 100;
