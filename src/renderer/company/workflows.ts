// ─── Superpowers Workflow Templates ───────────────────────────────────────────
// 에이전트 팀이 따라야 할 표준 워크플로우 정의.
// WorkflowStep.skill 은 agency-agents "superpowers" 스킬명과 1:1 매핑됩니다.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  /** agency-agents superpowers 스킬명 */
  skill: string;
  required: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** 이 워크플로우가 기본 추천되는 카테고리 목록 */
  recommendedFor: string[];
}

// ─── Workflow Definitions ─────────────────────────────────────────────────────

export const WORKFLOWS: WorkflowTemplate[] = [
  // ── Standard Development ──────────────────────────────────────────────────
  {
    id: 'standard-dev',
    name: 'Standard Development',
    description: 'Brainstorm → Plan → TDD → Review → Verify',
    steps: [
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: '설계 정제 + 요구사항 확인. 구현 전 모든 엣지 케이스를 논의합니다.',
        skill: 'brainstorming',
        required: true,
      },
      {
        id: 'plan',
        name: 'Write Plan',
        description: '2–5분 단위 태스크로 분해한 실행 계획을 작성합니다.',
        skill: 'writing-plans',
        required: true,
      },
      {
        id: 'tdd',
        name: 'Test-Driven Development',
        description: 'RED → GREEN → REFACTOR 사이클로 구현합니다.',
        skill: 'test-driven-development',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute Plan',
        description: '체크포인트를 확인하며 계획을 단계별로 실행합니다.',
        skill: 'executing-plans',
        required: true,
      },
      {
        id: 'review',
        name: 'Code Review',
        description: '리뷰 요청 후 피드백을 반영합니다.',
        skill: 'requesting-code-review',
        required: true,
      },
      {
        id: 'verify',
        name: 'Verification',
        description: '완료 전 모든 요구사항 충족 여부를 검증합니다.',
        skill: 'verification-before-completion',
        required: true,
      },
    ],
    recommendedFor: ['engineering', 'game-dev'],
  },

  // ── Design Workflow ───────────────────────────────────────────────────────
  {
    id: 'design-flow',
    name: 'Design Workflow',
    description: 'Brainstorm → Plan → Execute → Review',
    steps: [
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: '설계 컨셉 + 유저 리서치 인사이트를 통합합니다.',
        skill: 'brainstorming',
        required: true,
      },
      {
        id: 'plan',
        name: 'Write Plan',
        description: '디자인 태스크를 단계별로 분해합니다.',
        skill: 'writing-plans',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute Plan',
        description: '계획에 따라 디자인 산출물을 생성합니다.',
        skill: 'executing-plans',
        required: true,
      },
      {
        id: 'review',
        name: 'Design Review',
        description: '이해관계자 리뷰 후 피드백을 반영합니다.',
        skill: 'requesting-code-review',
        required: false,
      },
    ],
    recommendedFor: ['design', 'product'],
  },

  // ── Security Audit ────────────────────────────────────────────────────────
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Debug → Review → Verify',
    steps: [
      {
        id: 'debug',
        name: 'Systematic Analysis',
        description: '체계적 취약점 분석: 공격 표면 매핑 → 가설 수립 → 검증.',
        skill: 'systematic-debugging',
        required: true,
      },
      {
        id: 'review',
        name: 'Code Review',
        description: '보안 관점 코드 리뷰 및 수정 제안.',
        skill: 'requesting-code-review',
        required: true,
      },
      {
        id: 'verify',
        name: 'Verification',
        description: '패치 적용 후 재검증 및 최종 보안 서명.',
        skill: 'verification-before-completion',
        required: true,
      },
    ],
    recommendedFor: ['testing', 'specialized'],
  },

  // ── Rapid Prototyping ─────────────────────────────────────────────────────
  {
    id: 'rapid-prototype',
    name: 'Rapid Prototyping',
    description: 'Brainstorm → Execute (빠른 프로토타이핑)',
    steps: [
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: '아이디어를 빠르게 정제하고 핵심 가정을 정의합니다.',
        skill: 'brainstorming',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute',
        description: '최소 기능 프로토타입을 빠르게 구현합니다.',
        skill: 'executing-plans',
        required: true,
      },
    ],
    recommendedFor: ['marketing', 'sales', 'support'],
  },

  // ── Project Management ────────────────────────────────────────────────────
  {
    id: 'project-management',
    name: 'Project Management',
    description: 'Plan → Execute → Verify',
    steps: [
      {
        id: 'plan',
        name: 'Write Plan',
        description: '마일스톤과 세부 태스크를 정의하고 담당자를 배정합니다.',
        skill: 'writing-plans',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute Plan',
        description: '체크포인트 기반으로 진척을 추적하며 실행합니다.',
        skill: 'executing-plans',
        required: true,
      },
      {
        id: 'verify',
        name: 'Verification',
        description: '산출물 품질 및 완료 기준 충족 여부를 확인합니다.',
        skill: 'verification-before-completion',
        required: true,
      },
    ],
    recommendedFor: ['project-management'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 카테고리에 맞는 추천 워크플로우를 반환합니다. 매칭 없으면 standard-dev 를 기본값으로 사용합니다. */
export function getRecommendedWorkflow(category: string): WorkflowTemplate {
  return (
    WORKFLOWS.find((w) => w.recommendedFor.includes(category)) ?? WORKFLOWS[0]
  );
}

/** id 로 WorkflowTemplate 를 반환합니다. 없으면 undefined. */
export function getWorkflowById(id: string): WorkflowTemplate | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}
