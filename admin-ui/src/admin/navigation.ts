import {
  cilCheckCircle,
  cilCode,
  cilCloudDownload,
  cilDescription,
  cilNotes,
  cilPeople,
  cilShieldAlt,
  cilUser,
} from '@coreui/icons';

import type { AdminTab } from './types';

export const ADMIN_PATHS = {
  contacts: '/contacts',
  personality: '/personality',
  policy: '/policy',
  connections: '/connections',
  tools: '/tools',
  skills: '/skills',
  approvals: '/approvals',
  audit: '/audit',
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
    id: 'connections',
    path: ADMIN_PATHS.connections,
    label: 'Connections',
    description: 'Integration health and service reachability',
    icon: cilCloudDownload,
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
];

export function tabFromPathname(pathname: string): AdminTab | null {
  const matched = ADMIN_TABS.find((tab) => pathname === tab.path);
  return matched?.id || null;
}
