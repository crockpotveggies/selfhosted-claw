import { CCol, CRow, CWidgetStatsC } from '@coreui/react';
import {
  Activity,
  ChatDotsFill,
  EnvelopeFill,
  GeoAltFill,
  Google,
  HddNetworkFill,
  PhoneFill,
} from 'react-bootstrap-icons';

import { useAdminDashboardContext } from '../admin/context';

function buildConnectionStatus(ok: boolean, pendingLabel: string) {
  return {
    color: ok ? 'success' : 'danger',
    value: ok ? 'Online' : pendingLabel,
    progress: { color: ok ? 'success' : 'danger', value: ok ? 100 : 28 },
  } as const;
}

export function ConnectionsPage() {
  const dashboard = useAdminDashboardContext();
  const { providers, setupChecks } = dashboard;

  const widgets = [
    {
      title: 'OneCLI Gateway',
      icon: <HddNetworkFill size={20} />,
      note: providers.onecliConfigured
        ? providers.onecliReachable
          ? 'Credential proxy is reachable.'
          : 'Configured but not responding.'
        : 'Gateway URL is not configured.',
      ...buildConnectionStatus(
        providers.onecliConfigured && providers.onecliReachable,
        providers.onecliConfigured ? 'Unreachable' : 'Not configured',
      ),
    },
    {
      title: 'Google Contacts',
      icon: <Google size={20} />,
      note: providers.googleContactsAvailable
        ? `Connected via ${providers.googleContactsSource}.`
        : 'OAuth or token access has not been connected yet.',
      ...buildConnectionStatus(
        providers.googleContactsAvailable,
        'Offline',
      ),
    },
    {
      title: 'Signal Bridge',
      icon: <Activity size={20} />,
      note:
        setupChecks.signalComposeRunning && setupChecks.signalReachable
          ? 'Compose service is running and the RPC is reachable.'
          : 'Bridge still needs attention before it is fully healthy.',
      ...buildConnectionStatus(
        setupChecks.signalComposeRunning && setupChecks.signalReachable,
        'Degraded',
      ),
    },
    {
      title: 'Signal Outbound',
      icon: <ChatDotsFill size={20} />,
      note: providers.signalOutboundAvailable
        ? 'Signal message delivery is available.'
        : 'Signal outbound is not currently available.',
      ...buildConnectionStatus(providers.signalOutboundAvailable, 'Offline'),
    },
    {
      title: 'SMS Outbound',
      icon: <PhoneFill size={20} />,
      note: providers.smsOutboundAvailable
        ? 'SMS delivery is available.'
        : 'SMS delivery is not configured.',
      ...buildConnectionStatus(providers.smsOutboundAvailable, 'Offline'),
    },
    {
      title: 'Email Outbound',
      icon: <EnvelopeFill size={20} />,
      note: providers.emailOutboundAvailable
        ? 'Email delivery is available.'
        : 'Email delivery is not configured.',
      ...buildConnectionStatus(providers.emailOutboundAvailable, 'Offline'),
    },
    {
      title: 'Contact Resolution',
      icon: <GeoAltFill size={20} />,
      note: providers.contactResolutionAvailable
        ? 'Literal, history, or Google-backed target resolution is available.'
        : 'Name resolution support is currently offline.',
      ...buildConnectionStatus(providers.contactResolutionAvailable, 'Offline'),
    },
  ];

  return (
    <>
      <section className="panel">
        <div className="panelHeader">
          <h2>Connections</h2>
          <button onClick={() => void dashboard.refreshAll()}>Refresh</button>
        </div>
        <p className="mutedNote">
          Integration and service health now lives here instead of in the shared
          page header, which is frankly a much calmer place for it.
        </p>
      </section>

      <CRow className="g-4">
        {widgets.map((widget) => (
          <CCol key={widget.title} md={6} xl={4}>
            <CWidgetStatsC
              className="connectionWidget"
              color={widget.color}
              inverse
              icon={widget.icon}
              value={widget.value}
              title={
                <div className="connectionWidgetTitle">
                  <span>{widget.title}</span>
                  <small>{widget.note}</small>
                </div>
              }
              progress={widget.progress}
            />
          </CCol>
        ))}
      </CRow>
    </>
  );
}
