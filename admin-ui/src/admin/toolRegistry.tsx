import type { ReactNode } from 'react';
import {
  Calendar3,
  ChatDotsFill,
  GearFill,
  Google,
  PeopleFill,
  PersonBadgeFill,
  Robot,
  SendFill,
  ShieldLockFill,
} from 'react-bootstrap-icons';

import type { ToolRegistryItem } from './types';

interface ToolVisual {
  label: string;
  accent: string;
  accentSoft: string;
  icon: ReactNode;
}

export function formatRegistryName(name: string): string {
  return name
    .split(/[._-]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function getToolTypeKey(tool: ToolRegistryItem): string {
  return (tool.toolType || 'unknown').toLowerCase();
}

export function getToolVisual(tool: ToolRegistryItem): ToolVisual {
  const iconKey = (tool.iconKey || tool.toolType || 'unknown').toLowerCase();

  switch (iconKey) {
    case 'google_calendar':
    case 'calendar':
      return {
        label: 'Google Calendar',
        accent: '#f6c343',
        accentSoft: 'rgba(246, 195, 67, 0.16)',
        icon: <Calendar3 size={18} />,
      };
    case 'google_contacts':
    case 'google':
      return {
        label: 'Google Contacts',
        accent: '#4f9cff',
        accentSoft: 'rgba(79, 156, 255, 0.16)',
        icon: <Google size={18} />,
      };
    case 'signal':
      return {
        label: 'Signal',
        accent: '#5c7cfa',
        accentSoft: 'rgba(92, 124, 250, 0.16)',
        icon: <ChatDotsFill size={18} />,
      };
    case 'contacts':
    case 'people':
      return {
        label: 'Contacts',
        accent: '#2fb75d',
        accentSoft: 'rgba(47, 183, 93, 0.16)',
        icon: <PeopleFill size={18} />,
      };
    case 'personality':
      return {
        label: 'Personality',
        accent: '#8b5cf6',
        accentSoft: 'rgba(139, 92, 246, 0.16)',
        icon: <PersonBadgeFill size={18} />,
      };
    case 'policy':
      return {
        label: 'Policy',
        accent: '#f87171',
        accentSoft: 'rgba(248, 113, 113, 0.16)',
        icon: <ShieldLockFill size={18} />,
      };
    case 'settings':
      return {
        label: 'Settings',
        accent: '#94a3b8',
        accentSoft: 'rgba(148, 163, 184, 0.16)',
        icon: <GearFill size={18} />,
      };
    case 'outbound':
    case 'send':
      return {
        label: 'Outbound',
        accent: '#fb7185',
        accentSoft: 'rgba(251, 113, 133, 0.16)',
        icon: <SendFill size={18} />,
      };
    default:
      return {
        label: formatRegistryName(getToolTypeKey(tool)),
        accent: '#8892a6',
        accentSoft: 'rgba(136, 146, 166, 0.18)',
        icon: <Robot size={18} />,
      };
  }
}

export function getToolCapabilities(tool: ToolRegistryItem): string[] {
  return [
    tool.commandableAction ? 'Commandable' : 'UI only',
    tool.previewable ? 'Preview' : 'Direct',
    tool.interactiveView ? 'Interactive' : 'Action',
  ];
}
