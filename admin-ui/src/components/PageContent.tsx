import type { AdminTab } from '../admin/types';
import { ContactsPage } from '../pages/ContactsPage';
import { PersonalityPage } from '../pages/PersonalityPage';
import { PolicyPage } from '../pages/PolicyPage';
import { ToolsPage } from '../pages/ToolsPage';
import { SkillsPage } from '../pages/SkillsPage';
import { ApprovalsPage } from '../pages/ApprovalsPage';
import { AuditPage } from '../pages/AuditPage';

export function PageContent(props: { activeTab: AdminTab }) {
  switch (props.activeTab) {
    case 'contacts':
      return <ContactsPage />;
    case 'personality':
      return <PersonalityPage />;
    case 'policy':
      return <PolicyPage />;
    case 'tools':
      return <ToolsPage />;
    case 'skills':
      return <SkillsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'audit':
      return <AuditPage />;
    default:
      return null;
  }
}
