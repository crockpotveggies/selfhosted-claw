import { createContext, useContext } from 'react';

import type { AdminDashboardState } from './useAdminDashboard';

const AdminDashboardContext = createContext<AdminDashboardState | null>(null);

export const AdminDashboardProvider = AdminDashboardContext.Provider;

export function useAdminDashboardContext(): AdminDashboardState {
  const context = useContext(AdminDashboardContext);
  if (!context) {
    throw new Error('Admin dashboard context is unavailable');
  }
  return context;
}
