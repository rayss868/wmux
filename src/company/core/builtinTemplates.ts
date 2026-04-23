import type { CompanyTemplate } from '../types';

export const BUILTIN_TEMPLATES: CompanyTemplate[] = [
  {
    name: 'Full-Stack Team',
    departments: [
      {
        name: 'Engineering',
        leadName: 'CTO',
        leadPreset: 'backend-architect',
        members: [
          { name: 'FE Dev', preset: 'frontend-developer' },
          { name: 'BE Dev', preset: 'backend-architect' },
          { name: 'QA', preset: 'test-automator' },
        ],
      },
      {
        name: 'Security',
        leadName: 'CISO',
        leadPreset: 'security-auditor',
        members: [
          { name: 'Auditor', preset: 'security-auditor' },
        ],
      },
    ],
  },
  {
    name: 'Startup MVP',
    departments: [
      {
        name: 'Product',
        leadName: 'PM',
        leadPreset: 'project-manager',
        members: [
          { name: 'Full-Stack', preset: 'frontend-developer' },
          { name: 'Designer', preset: 'ui-designer' },
        ],
      },
    ],
  },
  {
    name: 'Code Review Squad',
    departments: [
      {
        name: 'Review',
        leadName: 'Lead Reviewer',
        leadPreset: 'code-reviewer',
        members: [
          { name: 'Security', preset: 'security-auditor' },
          { name: 'Quality', preset: 'test-automator' },
        ],
      },
    ],
  },
];
