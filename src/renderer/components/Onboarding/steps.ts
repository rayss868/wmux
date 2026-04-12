export interface OnboardingStep {
  id: string;
  targetSelector: string;
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'split-pane',
    targetSelector: '[data-onboarding-target="split-button"]',
    title: 'Split Terminal',
    description:
      'Press Ctrl+D to split the terminal vertically, or Ctrl+Shift+D to split horizontally. Run multiple commands side by side.',
    position: 'bottom',
  },
  {
    id: 'sidebar',
    targetSelector: '[data-onboarding-target="sidebar"]',
    title: 'Workspace Sidebar',
    description:
      'Manage your workspaces here. Create new ones, rename, or switch between them with a single click.',
    position: 'right',
  },
  {
    id: 'command-palette',
    targetSelector: '[data-onboarding-target="command-palette"]',
    title: 'Command Palette',
    description:
      'Press Ctrl+Shift+P to open the command palette. Quickly access any action without leaving the keyboard.',
    position: 'bottom',
  },
  {
    id: 'status-bar',
    targetSelector: '[data-onboarding-target="status-bar"]',
    title: 'Status Bar',
    description:
      'The status bar shows your active workspace, pane count, and quick actions. Right-click for more options.',
    position: 'bottom',
  },
];
