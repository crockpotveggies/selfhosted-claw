import { useEffect, useState } from 'react';
import {
  CBadge,
  CCloseButton,
  CContainer,
  CHeader,
  CHeaderBrand,
  CHeaderNav,
  CHeaderToggler,
  CPopover,
  CNavItem,
  CSidebar,
  CSidebarBrand,
  CSidebarFooter,
  CSidebarHeader,
  CSidebarNav,
  CSidebarToggler,
  CTooltip,
  useColorModes,
} from '@coreui/react';
import CIcon from '@coreui/icons-react';
import {
  cilMenu,
  cilSpeech,
} from '@coreui/icons';
import {
  BellFill,
  CheckSquareFill,
  ExclamationSquareFill,
  ExclamationTriangleFill,
  InfoCircleFill,
  XCircleFill,
} from 'react-bootstrap-icons';
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import { AdminDashboardProvider, useAdminDashboardContext } from './admin/context';
import { apiFetch } from './admin/api';
import { ADMIN_PATHS, ADMIN_TABS, tabFromPathname } from './admin/navigation';
import { useAdminDashboard } from './admin/useAdminDashboard';
import type { AdminTab } from './admin/types';
import { PageContent } from './components/PageContent';
import { SetupOverlay } from './components/SetupOverlay';

function AdminDashboardLayout() {
  const { setColorMode } = useColorModes('selfhosted-claw-admin-theme');
  const dashboard = useAdminDashboardContext();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarUnfoldable, setSidebarUnfoldable] = useState(false);
  const [notifications, setNotifications] = useState<
    Array<{ id: string; integration: string; severity: string; title: string; message: string }>
  >([]);

  // Poll notifications every 60 seconds
  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const data = await apiFetch<typeof notifications>('/api/admin/notifications');
        setNotifications(data);
      } catch {
        // Silently ignore — don't block UI
      }
    };
    void fetchNotifications();
    const interval = setInterval(() => void fetchNotifications(), 60000);
    return () => clearInterval(interval);
  }, []);

  const isSetupRoute = location.pathname === ADMIN_PATHS.setup;
  const matchedTab = tabFromPathname(location.pathname);
  const activeTab: AdminTab = matchedTab || 'dashboard';
  const activeTabMeta =
    ADMIN_TABS.find((tab) => tab.id === activeTab) || ADMIN_TABS[0];
  const systemChecks = [
    ['Model backend', dashboard.setupChecks.openAIConfigured],
    ['Signal account', dashboard.setupChecks.signalConfigured],
    ['Signal bridge', dashboard.setupChecks.signalComposeRunning],
    ['Control chat', dashboard.setupChecks.controlChatConfigured],
    ['Verified identities', dashboard.setupChecks.verifiedIdentityCount > 0],
  ] as const;
  const healthyCheckCount = systemChecks.filter(([, ok]) => ok).length;
  const allChecksHealthy = healthyCheckCount === systemChecks.length;

  useEffect(() => {
    setColorMode('dark');
  }, [setColorMode]);

  useEffect(() => {
    if (location.pathname === '/') {
      navigate(
        `${ADMIN_PATHS.dashboard}${location.search}${location.hash}`,
        { replace: true },
      );
      return;
    }

    const validPath =
      isSetupRoute || ADMIN_TABS.some((tab) => tab.path === location.pathname);
    if (!validPath) {
      navigate(ADMIN_PATHS.dashboard, { replace: true });
    }
  }, [isSetupRoute, location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const googleStatus = searchParams.get('google_contacts');
    const message = searchParams.get('message');

    if (!googleStatus) return;

    if (googleStatus === 'connected') {
      dashboard.setToast({
        kind: 'success',
        text: message || 'Google Contacts connected.',
      });
      void dashboard.refreshAll();
    } else if (googleStatus === 'error') {
      dashboard.setToast({
        kind: 'error',
        text: message || 'Google Contacts connection failed.',
      });
    }

    searchParams.delete('tab');
    searchParams.delete('google_contacts');
    searchParams.delete('message');
    const nextSearch = searchParams.toString();
    navigate(
      {
        pathname:
          location.pathname === '/' ? ADMIN_PATHS.dashboard : location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
        hash: location.hash,
      },
      { replace: true },
    );
  }, [dashboard, location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!dashboard.setupBlocked && isSetupRoute) {
      navigate(ADMIN_PATHS.dashboard, { replace: true });
    }
  }, [dashboard.setupBlocked, isSetupRoute, navigate]);

  const heroEyebrow = isSetupRoute ? 'Setup' : activeTabMeta.label;
  const heroTitle = isSetupRoute
    ? 'Initial configuration overlay'
    : activeTabMeta.description;

  return (
    <div className="adminCoreui">
      {dashboard.toast ? (
        <div className={`toast ${dashboard.toast.kind}`}>{dashboard.toast.text}</div>
      ) : null}

      <CSidebar
        className="border-end adminSidebar"
        colorScheme="dark"
        position="fixed"
        unfoldable={sidebarUnfoldable}
        visible={sidebarVisible}
        onVisibleChange={setSidebarVisible}
      >
        <CSidebarHeader className="border-bottom">
          <CSidebarBrand className="adminSidebarBrand" href="#">
            <div className="brandMark">
              <CIcon icon={cilSpeech} size="lg" />
            </div>
            <div className="brandCopy">
              <span>Self-Hosted Claw</span>
              <small>Admin control plane</small>
            </div>
          </CSidebarBrand>
          <CCloseButton className="d-lg-none" dark onClick={() => setSidebarVisible(false)} />
        </CSidebarHeader>
        <CSidebarNav className="adminSidebarNav">
          {ADMIN_TABS.map((tab) => (
            <CNavItem key={tab.id}>
              <CTooltip content={tab.description} placement="right" trigger={['hover', 'focus']}>
                <NavLink
                  to={tab.path}
                  className={({ isActive }) =>
                    `navItem nav-link navRouterLink${isActive ? ' active' : ''}`
                  }
                >
                  <CIcon className="navIcon" icon={tab.icon} />
                  <span>{tab.label}</span>
                </NavLink>
              </CTooltip>
            </CNavItem>
          ))}
        </CSidebarNav>
        <CSidebarFooter className="border-top d-none d-lg-flex justify-content-between align-items-center">
          <NavLink to={ADMIN_PATHS.setup} className="setupLink">
            <CBadge className={`setupBadge ${dashboard.setupBlocked ? 'warn' : 'ok'}`}>
              {dashboard.setupBlocked ? 'Setup required' : 'Review setup'}
            </CBadge>
          </NavLink>
          <CSidebarToggler onClick={() => setSidebarUnfoldable((current) => !current)} />
        </CSidebarFooter>
      </CSidebar>

      <div className="wrapper d-flex flex-column min-vh-100 adminWrapper">
        <CHeader position="sticky" className="mb-4 p-0 adminHeader">
          <CContainer fluid className="border-bottom px-4">
            <CHeaderToggler
              onClick={() => setSidebarVisible((current) => !current)}
              style={{ marginInlineStart: '-14px' }}
            >
              <CIcon icon={cilMenu} size="lg" />
            </CHeaderToggler>
            <CHeaderBrand className="d-md-none" href="#">
              Claw Admin
            </CHeaderBrand>
            <CHeaderNav className="ms-auto adminStatusNav">
              {dashboard.setupBlocked ? (
                <CNavItem>
                  <NavLink to={ADMIN_PATHS.setup} className="setupLink">
                    <CBadge className="setupBadge warn">Setup incomplete</CBadge>
                  </NavLink>
                </CNavItem>
              ) : null}
              {/* Notification bell */}
              <CNavItem>
                <CPopover
                  trigger="click"
                  placement="bottom"
                  className="healthPopover"
                  content={
                    <div style={{ minWidth: 280, maxWidth: 360 }}>
                      {notifications.length === 0 ? (
                        <div className="text-body-secondary small p-2 text-center">
                          No notifications
                        </div>
                      ) : (
                        notifications.map((n) => (
                          <div
                            key={n.id}
                            className="d-flex gap-2 p-2 border-bottom"
                            style={{ cursor: 'pointer' }}
                            onClick={() =>
                              navigate(
                                `${ADMIN_PATHS.integrations}?select=${encodeURIComponent(n.integration)}`,
                              )
                            }
                          >
                            <div className="mt-1">
                              {n.severity === 'error' ? (
                                <XCircleFill size={14} className="text-danger" />
                              ) : n.severity === 'warning' ? (
                                <ExclamationTriangleFill size={14} className="text-warning" />
                              ) : (
                                <InfoCircleFill size={14} className="text-info" />
                              )}
                            </div>
                            <div>
                              <div className="small fw-semibold">{n.title}</div>
                              <div className="small text-body-secondary">{n.message}</div>
                              <div className="small text-body-tertiary">{n.integration}</div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  }
                >
                  <button
                    type="button"
                    className="position-relative btn btn-link p-1"
                    style={{ color: 'var(--cui-header-color)' }}
                  >
                    <BellFill size={18} />
                    {notifications.length > 0 && (
                      <CBadge
                        color="danger"
                        shape="rounded-pill"
                        className="position-absolute top-0 start-100 translate-middle"
                        style={{ fontSize: '0.65rem', padding: '0.2em 0.45em' }}
                      >
                        {notifications.length}
                      </CBadge>
                    )}
                  </button>
                </CPopover>
              </CNavItem>

              {/* Health status */}
              <CNavItem>
                <CPopover
                  trigger="click"
                  placement="bottom"
                  className="healthPopover"
                  content={
                    <div className="healthPopoverContent">
                      {systemChecks.map(([label, ok]) => (
                        <div key={label} className="healthPopoverRow">
                          <span className={`healthCheckIcon ${ok ? 'ok' : 'error'}`}>
                            {ok ? (
                              <CheckSquareFill size={14} />
                            ) : (
                              <ExclamationSquareFill size={14} />
                            )}
                          </span>
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                  }
                >
                  <button
                    type="button"
                    className={`statusSummaryBadge ${allChecksHealthy ? 'ok' : 'error'}`}
                  >
                    {allChecksHealthy ? (
                      <CheckSquareFill size={14} />
                    ) : (
                      <ExclamationSquareFill size={14} />
                    )}
                    {healthyCheckCount}/{systemChecks.length} Status Checks
                  </button>
                </CPopover>
              </CNavItem>
            </CHeaderNav>
          </CContainer>
          <CContainer fluid className="px-4 py-2 adminHeaderDetails">
            <div className="d-flex align-items-center gap-2">
              <span className="heroEyebrow">{heroEyebrow}</span>
              <span className="adminPageTitle ms-auto">{heroTitle}</span>
              <CTooltip
                content="The admin UI and Signal control chat call the same host-side actions, so everything here reflects the real control plane."
                placement="bottom"
              >
                <span className="headerHelpIcon">?</span>
              </CTooltip>
            </div>
          </CContainer>
        </CHeader>

        <div className="body flex-grow-1 adminBody">
          <CContainer fluid className="px-4">
            <PageContent activeTab={activeTab} />
          </CContainer>
        </div>
      </div>

      <SetupOverlay visible={dashboard.setupBlocked || isSetupRoute} />
    </div>
  );
}

export function App() {
  const dashboard = useAdminDashboard();

  return (
    <AdminDashboardProvider value={dashboard}>
      <Routes>
        <Route path="/" element={<AdminDashboardLayout />} />
        {ADMIN_TABS.map((tab) => (
          <Route key={tab.id} path={tab.path} element={<AdminDashboardLayout />} />
        ))}
        <Route path={ADMIN_PATHS.setup} element={<AdminDashboardLayout />} />
        <Route path="*" element={<Navigate to={ADMIN_PATHS.dashboard} replace />} />
      </Routes>
    </AdminDashboardProvider>
  );
}
