import { useEffect, useState } from 'react';
import {
  CBadge,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CProgress,
  CRow,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from '@coreui/react';
import {
  ChatDotsFill,
  PeopleFill,
  GearFill,
  ShieldCheck,
  ExclamationTriangleFill,
  ClockFill,
  JournalText,
  Activity,
} from 'react-bootstrap-icons';

import { apiFetch } from '../admin/api';
import { PaginatedTable } from '../components/PaginatedTable';

interface DashboardData {
  metrics: {
    groups: number;
    chats: number;
    contacts: number;
    pendingApprovals: number;
    activeTasks: number;
    integrations: number;
    logEventsLast24h: number;
    logEventsLast7d: number;
    errorsLast24h: number;
  };
  recentActivity: Array<{
    chatName: string;
    senderName: string;
    content: string;
    timestamp: string;
    channel: string;
    isFromMe: boolean;
  }>;
  auditRecent: Array<{
    actionName: string;
    status: string;
    createdAt: string;
    summary: string;
  }>;
}

function MetricCard({
  icon,
  color,
  title,
  value,
  period,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  value: number | string;
  period?: string;
}) {
  return (
    <CCard
      className="mb-0 overflow-hidden"
      style={{ borderTop: `3px solid var(--cui-${color})` }}
    >
      <CCardBody className="pb-0 d-flex justify-content-between align-items-start">
        <div>
          <div
            className="fs-4 fw-semibold"
            style={{ color: `var(--cui-${color})` }}
          >
            {value}
          </div>
          <div className="text-body-secondary small text-uppercase fw-semibold">
            {title}
          </div>
        </div>
        <div
          className="d-flex align-items-center justify-content-center rounded"
          style={{
            width: 40,
            height: 40,
            background: `rgba(var(--cui-${color}-rgb), 0.1)`,
            color: `var(--cui-${color})`,
          }}
        >
          {icon}
        </div>
      </CCardBody>
      <div className="px-3 pb-2">
        {period && (
          <small className="text-body-tertiary">{period}</small>
        )}
      </div>
    </CCard>
  );
}

function channelBadgeColor(channel: string): string {
  switch (channel) {
    case 'signal':
      return 'primary';
    case 'whatsapp':
      return 'success';
    case 'telegram':
      return 'info';
    case 'slack':
      return 'warning';
    case 'discord':
      return 'dark';
    default:
      return 'secondary';
  }
}

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusBadgeColor(status: string): string {
  switch (status) {
    case 'success':
      return 'success';
    case 'error':
      return 'danger';
    case 'pending':
      return 'warning';
    case 'rejected':
      return 'secondary';
    default:
      return 'info';
  }
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await apiFetch<DashboardData>('/api/admin/dashboard'));
    } catch {
      // Error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Auto-refresh every 30 seconds
    const interval = setInterval(() => void load(), 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <section className="panel">
        <p>Loading dashboard...</p>
      </section>
    );
  }

  if (!data) return null;
  const m = data.metrics;

  return (
    <>
      {/* Metric cards */}
      <CRow className="g-3 mb-4">
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<PeopleFill size={20} />}
            color="primary"
            title="Contacts"
            value={m.contacts}
            period="Total known identities"
          />
        </CCol>
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<ChatDotsFill size={20} />}
            color="info"
            title="Chats"
            value={m.chats}
            period={`${m.groups} registered groups`}
          />
        </CCol>
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<Activity size={20} />}
            color="success"
            title="Log Events"
            value={m.logEventsLast24h}
            period="Last 24 hours"
          />
        </CCol>
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<ExclamationTriangleFill size={20} />}
            color="danger"
            title="Errors"
            value={m.errorsLast24h}
            period="Last 24 hours"
          />
        </CCol>
      </CRow>

      <CRow className="g-3 mb-4">
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<GearFill size={20} />}
            color="warning"
            title="Integrations"
            value={m.integrations}
            period="Registered"
          />
        </CCol>
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<ShieldCheck size={20} />}
            color="success"
            title="Pending Approvals"
            value={m.pendingApprovals}
            period="Awaiting decision"
          />
        </CCol>
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<ClockFill size={20} />}
            color="info"
            title="Active Tasks"
            value={m.activeTasks}
            period="Scheduled"
          />
        </CCol>
        <CCol sm={6} lg={3}>
          <MetricCard
            icon={<JournalText size={20} />}
            color="secondary"
            title="Weekly Events"
            value={m.logEventsLast7d}
            period="Last 7 days"
          />
        </CCol>
      </CRow>

      {/* Recent activity table */}
      <CCard className="mb-4">
        <CCardHeader>
          <strong>Recent Activity</strong>
        </CCardHeader>
        <CCardBody className="p-0">
          <PaginatedTable
            items={data.recentActivity}
            defaultPageSize={50}
            renderTable={(pageItems) => (
              <CTable hover responsive align="middle" className="mb-0">
                <CTableHead className="text-nowrap">
                  <CTableRow>
                    <CTableHeaderCell className="bg-body-tertiary">Chat</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary">Sender</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary">Message</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary text-center">Channel</CTableHeaderCell>
                    <CTableHeaderCell className="bg-body-tertiary">When</CTableHeaderCell>
                  </CTableRow>
                </CTableHead>
                <CTableBody>
                  {pageItems.length === 0 ? (
                    <CTableRow>
                      <CTableDataCell colSpan={5} className="text-center text-body-secondary py-4">No recent messages</CTableDataCell>
                    </CTableRow>
                  ) : (
                    pageItems.map((msg, i) => (
                      <CTableRow key={i}>
                        <CTableDataCell><div className="fw-semibold small">{msg.chatName || '—'}</div></CTableDataCell>
                        <CTableDataCell>
                          <div className="small">
                            {msg.isFromMe ? <span className="text-body-secondary fst-italic">(assistant)</span> : msg.senderName || '—'}
                          </div>
                        </CTableDataCell>
                        <CTableDataCell><div className="small text-truncate" style={{ maxWidth: 300 }}>{msg.content}</div></CTableDataCell>
                        <CTableDataCell className="text-center">
                          {msg.channel && <CBadge size="sm" color={channelBadgeColor(msg.channel)}>{msg.channel}</CBadge>}
                        </CTableDataCell>
                        <CTableDataCell><div className="small text-body-secondary text-nowrap">{timeAgo(msg.timestamp)}</div></CTableDataCell>
                      </CTableRow>
                    ))
                  )}
                </CTableBody>
              </CTable>
            )}
          />
        </CCardBody>
      </CCard>

      {/* Recent audit */}
      {data.auditRecent.length > 0 && (
        <CCard>
          <CCardHeader>
            <strong>Recent Control Actions</strong>
          </CCardHeader>
          <CCardBody className="p-0">
            <CTable hover responsive align="middle" className="mb-0">
              <CTableHead className="text-nowrap">
                <CTableRow>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Action
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary text-center">
                    Status
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    Summary
                  </CTableHeaderCell>
                  <CTableHeaderCell className="bg-body-tertiary">
                    When
                  </CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {data.auditRecent.map((a, i) => (
                  <CTableRow key={i}>
                    <CTableDataCell>
                      <code className="small">{a.actionName}</code>
                    </CTableDataCell>
                    <CTableDataCell className="text-center">
                      <CBadge
                        size="sm"
                        color={statusBadgeColor(a.status)}
                      >
                        {a.status}
                      </CBadge>
                    </CTableDataCell>
                    <CTableDataCell>
                      <div
                        className="small text-truncate"
                        style={{ maxWidth: 250 }}
                      >
                        {a.summary}
                      </div>
                    </CTableDataCell>
                    <CTableDataCell>
                      <div className="small text-body-secondary text-nowrap">
                        {timeAgo(a.createdAt)}
                      </div>
                    </CTableDataCell>
                  </CTableRow>
                ))}
              </CTableBody>
            </CTable>
          </CCardBody>
        </CCard>
      )}
    </>
  );
}
