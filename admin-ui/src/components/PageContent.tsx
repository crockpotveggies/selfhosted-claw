import type { AdminTab } from '../admin/types';
import { DashboardPage } from '../pages/DashboardPage';
import { ContactsPage } from '../pages/ContactsPage';
import { PersonalityPage } from '../pages/PersonalityPage';
import { PolicyPage } from '../pages/PolicyPage';
import { AvailabilityPage } from '../pages/AvailabilityPage';
import { IntegrationsPage } from '../pages/IntegrationsPage';
import { ToolsPage } from '../pages/ToolsPage';
import { SkillsPage } from '../pages/SkillsPage';
import { TasksPage } from '../pages/TasksPage';
import { ApprovalsPage } from '../pages/ApprovalsPage';
import { AuditPage } from '../pages/AuditPage';
import { LogsPage } from '../pages/LogsPage';

export function PageContent(props: { activeTab: AdminTab }) {
  switch (props.activeTab) {
    case 'dashboard':
      return <DashboardPage />;
    case 'contacts':
      return <ContactsPage />;
    case 'personality':
      return <PersonalityPage />;
    case 'policy':
      return <PolicyPage />;
    case 'availability':
      return <AvailabilityPage />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'skills':
      return <SkillsPage />;
    case 'tasks':
      return <TasksPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'audit':
      return <AuditPage />;
    case 'logs':
      return <LogsPage />;
    default:
      return null;
  }
}
