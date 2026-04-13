import {
  cilCheckCircle,
  cilCode,
  cilDescription,
  cilNotes,
  cilPeople,
  cilPuzzle,
  cilShieldAlt,
  cilSpeedometer,
  cilCalendar,
  cilClock,
  cilUser,
  cilGraph,
} from '@coreui/icons';

import type { AdminTab } from './types';

export const ADMIN_PATHS = {
  dashboard: '/dashboard',
  contacts: '/contacts',
  personality: '/personality',
  policy: '/policy',
  availability: '/availability',
  integrations: '/integrations',
  tools: '/tools',
  skills: '/skills',
  tasks: '/tasks',
  approvals: '/approvals',
  audit: '/audit',
  logs: '/logs',
  setup: '/setup',
} as const;

export const ADMIN_TABS: Array<{
  id: AdminTab;
  path: string;
  label: string;
  description: string;
  icon: unknown;
}> = [
  {
    id: 'dashboard',
    path: ADMIN_PATHS.dashboard,
    label: 'Dashboard',
    description: 'System overview and recent activity',
    icon: cilGraph,
  },
  {
    id: 'contacts',
    path: ADMIN_PATHS.contacts,
    label: 'Contacts',
    description: 'People and identity control',
    icon: cilPeople,
  },
  {
    id: 'personality',
    path: ADMIN_PATHS.personality,
    label: 'Personality',
    description: 'Voice, role, and prompt shaping',
    icon: cilUser,
  },
  {
    id: 'policy',
    path: ADMIN_PATHS.policy,
    label: 'Policy',
    description: 'Provider switches and trust settings',
    icon: cilShieldAlt,
  },
  {
    id: 'availability',
    path: ADMIN_PATHS.availability,
    label: 'Availability',
    description: 'Calendar availability windows and scheduling preferences',
    icon: cilCalendar,
  },
  {
    id: 'integrations',
    path: ADMIN_PATHS.integrations,
    label: 'Integrations',
    description: 'Installed integrations and their settings',
    icon: cilPuzzle,
  },
  {
    id: 'tools',
    path: ADMIN_PATHS.tools,
    label: 'Tools',
    description: 'Registry-backed control actions and integrations',
    icon: cilNotes,
  },
  {
    id: 'skills',
    path: ADMIN_PATHS.skills,
    label: 'Skills',
    description: 'Container skill definitions',
    icon: cilCode,
  },
  {
    id: 'tasks',
    path: ADMIN_PATHS.tasks,
    label: 'Tasks',
    description: 'Scheduled and recurring agent tasks',
    icon: cilClock,
  },
  {
    id: 'approvals',
    path: ADMIN_PATHS.approvals,
    label: 'Approvals',
    description: 'Pending actions that need a human',
    icon: cilCheckCircle,
  },
  {
    id: 'audit',
    path: ADMIN_PATHS.audit,
    label: 'Audit',
    description: 'Action history and accountability',
    icon: cilDescription,
  },
  {
    id: 'logs',
    path: ADMIN_PATHS.logs,
    label: 'Logs',
    description: 'Structured log viewer with filtering',
    icon: cilSpeedometer,
  },
];

export function tabFromPathname(pathname: string): AdminTab | null {
  const matched = ADMIN_TABS.find((tab) => pathname === tab.path);
  return matched?.id || null;
}
