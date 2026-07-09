import { useState, useRef, useEffect } from 'react';
import type { AgentPreset } from '../../types';

interface AddMemberDialogProps {
  deptName: string;
  onConfirm: (name: string, preset: AgentPreset, customPath?: string) => void;
  onCancel: () => void;
}

interface PresetGroup {
  label: string;
  presets: { value: AgentPreset; label: string }[];
}

const PRESET_GROUPS: PresetGroup[] = [
  {
    label: 'Engineering',
    presets: [
      { value: 'software-architect',    label: 'Software Architect' },
      { value: 'senior-developer',      label: 'Senior Developer' },
      { value: 'frontend-developer',    label: 'Frontend Developer' },
      { value: 'backend-architect',     label: 'Backend Architect' },
      { value: 'ai-engineer',           label: 'AI Engineer' },
      { value: 'data-engineer',         label: 'Data Engineer' },
      { value: 'database-optimizer',    label: 'Database Optimizer' },
      { value: 'devops-automator',      label: 'DevOps Automator' },
      { value: 'sre',                   label: 'Site Reliability Engineer' },
      { value: 'security-engineer',     label: 'Security Engineer' },
      { value: 'code-reviewer',         label: 'Code Reviewer' },
      { value: 'technical-writer',      label: 'Technical Writer' },
    ],
  },
  {
    label: 'Design',
    presets: [
      { value: 'ux-architect',          label: 'UX Architect' },
      { value: 'ui-designer',           label: 'UI Designer' },
      { value: 'ux-researcher',         label: 'UX Researcher' },
      { value: 'brand-guardian',        label: 'Brand Guardian' },
      { value: 'visual-storyteller',    label: 'Visual Storyteller' },
      { value: 'image-prompt-engineer', label: 'Image Prompt Engineer' },
    ],
  },
  {
    label: 'Project Management',
    presets: [
      { value: 'studio-producer',        label: 'Studio Producer' },
      { value: 'project-shepherd',       label: 'Project Shepherd' },
      { value: 'senior-project-manager', label: 'Senior Project Manager' },
      { value: 'studio-operations',      label: 'Studio Operations' },
      { value: 'experiment-tracker',     label: 'Experiment Tracker' },
    ],
  },
  {
    label: 'Testing',
    presets: [
      { value: 'accessibility-auditor',   label: 'Accessibility Auditor' },
      { value: 'api-tester',              label: 'API Tester' },
      { value: 'performance-benchmarker', label: 'Performance Benchmarker' },
      { value: 'test-results-analyzer',   label: 'Test Results Analyzer' },
      { value: 'workflow-optimizer',      label: 'Workflow Optimizer' },
      { value: 'reality-checker',         label: 'Reality Checker' },
    ],
  },
  {
    label: 'Sales',
    presets: [
      { value: 'sales-coach',         label: 'Sales Coach' },
      { value: 'account-strategist',  label: 'Account Strategist' },
      { value: 'deal-strategist',     label: 'Deal Strategist' },
      { value: 'outbound-strategist', label: 'Outbound Strategist' },
      { value: 'pipeline-analyst',    label: 'Pipeline Analyst' },
      { value: 'sales-engineer',      label: 'Sales Engineer' },
    ],
  },
  {
    label: 'Marketing',
    presets: [
      { value: 'growth-hacker',       label: 'Growth Hacker' },
      { value: 'content-creator',     label: 'Content Creator' },
      { value: 'seo-specialist',      label: 'SEO Specialist' },
      { value: 'podcast-strategist',  label: 'Podcast Strategist' },
      { value: 'linkedin-strategist', label: 'LinkedIn Strategist' },
      { value: 'tiktok-strategist',   label: 'TikTok Strategist' },
    ],
  },
  {
    label: 'Product',
    presets: [
      { value: 'product-manager',      label: 'Product Manager' },
      { value: 'feedback-synthesizer', label: 'Feedback Synthesizer' },
      { value: 'feature-prioritizer',  label: 'Feature Prioritizer' },
      { value: 'roadmap-strategist',   label: 'Roadmap Strategist' },
    ],
  },
  {
    label: 'Specialized',
    presets: [
      { value: 'agents-orchestrator',    label: 'Agents Orchestrator' },
      { value: 'workflow-architect',     label: 'Workflow Architect' },
      { value: 'mcp-builder',           label: 'MCP Builder' },
      { value: 'compliance-auditor',    label: 'Compliance Auditor' },
      { value: 'developer-advocate',    label: 'Developer Advocate' },
      { value: 'recruitment-specialist', label: 'Recruitment Specialist' },
    ],
  },
  {
    label: 'Custom',
    presets: [
      { value: 'custom', label: 'Custom Agent...' },
    ],
  },
];

export default function AddMemberDialog({ deptName, onConfirm, onCancel }: AddMemberDialogProps) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<AgentPreset>('frontend-developer');
  const [customPath, setCustomPath] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isCustom = preset === 'custom';
  const isValid = name.trim().length > 0 && (!isCustom || customPath.trim().length > 0);

  const handleSubmit = () => {
    if (!isValid) return;
    onConfirm(name.trim(), preset, isCustom ? customPath.trim() : undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--backdrop-modal)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 340,
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          borderRadius: 8,
          padding: 20,
          boxShadow: 'var(--shadow-modal-soft)',
        }}
      >
        {/* header */}
        <div className="mb-4">
          <div className="text-xs font-mono font-bold" style={{ color: 'var(--text-main)' }}>
            Add Member
          </div>
          <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {deptName}
          </div>
        </div>

        {/* name input */}
        <div className="mb-4">
          <label
            className="block text-[9px] font-mono font-bold uppercase tracking-wider mb-1.5"
            style={{ color: 'var(--text-muted)' }}
          >
            Name
          </label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Alice"
            className="w-full px-3 py-2 rounded text-xs font-mono focus:outline-none placeholder:opacity-40"
            style={{
              backgroundColor: 'var(--bg-mantle)',
              color: 'var(--text-main)',
              border: '1px solid var(--bg-surface)',
            }}
          />
        </div>

        {/* preset selector */}
        <div className="mb-4">
          <label
            className="block text-[9px] font-mono font-bold uppercase tracking-wider mb-1.5"
            style={{ color: 'var(--text-muted)' }}
          >
            Role / Preset
          </label>
          <div
            className="overflow-y-auto space-y-2"
            style={{ maxHeight: 220 }}
          >
            {PRESET_GROUPS.map((group) => (
              <div key={group.label}>
                <div
                  className="text-[8px] font-mono font-bold uppercase tracking-wider mb-1 px-1"
                  style={{ color: 'var(--text-subtle)' }}
                >
                  {group.label}
                </div>
                <div className="grid grid-cols-2 gap-0.5">
                  {group.presets.map((p) => {
                    const selected = preset === p.value;
                    return (
                      <button
                        key={p.value}
                        onClick={() => setPreset(p.value)}
                        className="text-left px-2 py-1 rounded text-[9px] font-mono truncate"
                        style={{
                          backgroundColor: selected
                            ? 'rgba(137, 180, 250, 0.12)'
                            : 'var(--bg-mantle)',
                          color: selected ? 'var(--accent-blue)' : 'var(--text-main)',
                          border: selected
                            ? '1px solid var(--accent-blue)'
                            : '1px solid transparent',
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* custom path input — only when custom preset is selected */}
        {isCustom && (
          <div className="mb-4">
            <label
              className="block text-[9px] font-mono font-bold uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--text-muted)' }}
            >
              Agent Path
            </label>
            <input
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="/path/to/agent or agent-id"
              className="w-full px-3 py-2 rounded text-xs font-mono focus:outline-none placeholder:opacity-40"
              style={{
                backgroundColor: 'var(--bg-mantle)',
                color: 'var(--text-main)',
                border: '1px solid var(--bg-surface)',
              }}
            />
          </div>
        )}

        {/* action bar */}
        <div
          className="flex items-center justify-between pt-3"
          style={{ borderTop: '1px solid var(--bg-surface)' }}
        >
          <button
            onClick={onCancel}
            className="text-[11px] font-mono transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-main)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid}
            className="px-4 py-1.5 rounded text-[11px] font-mono font-bold hover:opacity-90 disabled:opacity-30"
            style={{
              backgroundColor: 'var(--accent-blue)',
              color: 'var(--bg-base)',
            }}
          >
            Add Member
          </button>
        </div>
      </div>
    </div>
  );
}
