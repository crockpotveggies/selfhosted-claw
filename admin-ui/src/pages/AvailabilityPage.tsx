import {
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormCheck,
  CFormInput,
  CFormTextarea,
  CRow,
} from '@coreui/react';
import { PlusCircle, TrashFill, CalendarWeek } from 'react-bootstrap-icons';

import { useAdminDashboardContext } from '../admin/context';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function AvailabilityPage() {
  const dashboard = useAdminDashboardContext();
  const saveKey = 'calendar-availability-save';

  return (
    <CRow className="g-3">
      {/* Windows editor */}
      <CCol lg={7}>
        <CCard>
          <CCardHeader className="d-flex justify-content-between align-items-center">
            <div className="d-flex align-items-center gap-2">
              <CalendarWeek size={16} />
              <strong>Availability Windows</strong>
            </div>
            <CButton
              size="sm"
              color="primary"
              onClick={() =>
                dashboard.setCalAvailWindows([
                  ...dashboard.calAvailWindows,
                  { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
                ])
              }
            >
              <PlusCircle size={12} className="me-1" />
              Add Window
            </CButton>
          </CCardHeader>
          <CCardBody>
            <p className="small text-body-secondary mb-3">
              The agent will only propose meeting times within these windows.
            </p>

            {dashboard.calAvailWindows.length === 0 ? (
              <p className="text-body-tertiary small">
                No availability windows defined. Add one to get started.
              </p>
            ) : (
              <div className="d-flex flex-column gap-3">
                {dashboard.calAvailWindows.map((window, idx) => (
                  <CCard key={idx}>
                    <CCardBody className="py-3">
                      {/* Days */}
                      <div className="d-flex flex-wrap gap-2 mb-3">
                        {DAY_NAMES.map((name, dayIdx) => (
                          <CFormCheck
                            key={dayIdx}
                            inline
                            id={`day-${idx}-${dayIdx}`}
                            label={name}
                            checked={window.days.includes(dayIdx)}
                            onChange={(e) => {
                              const updated = [...dashboard.calAvailWindows];
                              updated[idx] = {
                                ...window,
                                days: e.target.checked
                                  ? [...window.days, dayIdx].sort()
                                  : window.days.filter((d) => d !== dayIdx),
                              };
                              dashboard.setCalAvailWindows(updated);
                            }}
                          />
                        ))}
                      </div>

                      {/* Time range + remove */}
                      <div className="d-flex align-items-center gap-2">
                        <CFormInput
                          type="time"
                          size="sm"
                          style={{ width: 130 }}
                          value={window.startTime}
                          onChange={(e) => {
                            const updated = [...dashboard.calAvailWindows];
                            updated[idx] = { ...window, startTime: e.target.value };
                            dashboard.setCalAvailWindows(updated);
                          }}
                        />
                        <span className="small text-body-secondary">to</span>
                        <CFormInput
                          type="time"
                          size="sm"
                          style={{ width: 130 }}
                          value={window.endTime}
                          onChange={(e) => {
                            const updated = [...dashboard.calAvailWindows];
                            updated[idx] = { ...window, endTime: e.target.value };
                            dashboard.setCalAvailWindows(updated);
                          }}
                        />
                        <div className="ms-auto">
                          <CButton
                            size="sm"
                            color="danger"
                            variant="ghost"
                            onClick={() => {
                              if (!confirm('Remove this availability window?')) return;
                              dashboard.setCalAvailWindows(
                                dashboard.calAvailWindows.filter((_, i) => i !== idx),
                              );
                            }}
                          >
                            <TrashFill size={12} />
                          </CButton>
                        </div>
                      </div>

                      {/* Summary */}
                      <div className="mt-2">
                        {window.days.map((d) => (
                          <CBadge key={d} color="dark" size="sm" className="me-1">
                            {DAY_NAMES[d]}
                          </CBadge>
                        ))}
                        <span className="small text-body-secondary ms-1">
                          {window.startTime} – {window.endTime}
                        </span>
                      </div>
                    </CCardBody>
                  </CCard>
                ))}
              </div>
            )}
          </CCardBody>
        </CCard>
      </CCol>

      {/* Right column — timezone, notes, save */}
      <CCol lg={5}>
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Timezone</strong>
          </CCardHeader>
          <CCardBody>
            <label className="form-label small fw-semibold">IANA Timezone</label>
            <CFormInput
              size="sm"
              value={dashboard.calAvailTimezone}
              onChange={(e) => dashboard.setCalAvailTimezone(e.target.value)}
              placeholder="America/New_York"
            />
            <div className="small text-body-secondary mt-1">
              e.g. America/Vancouver, Europe/London, Asia/Tokyo
            </div>
          </CCardBody>
        </CCard>

        <CCard className="mb-3">
          <CCardHeader>
            <strong>Additional Notes</strong>
          </CCardHeader>
          <CCardBody>
            <CFormTextarea
              rows={4}
              value={dashboard.calAvailNotes}
              onChange={(e) => dashboard.setCalAvailNotes(e.target.value)}
              placeholder="e.g. No meetings before 10am on Mondays. Prefer afternoons for deep work."
            />
          </CCardBody>
        </CCard>

        <CButton
          color="primary"
          disabled={dashboard.isPending(saveKey)}
          onClick={() =>
            void dashboard.runWithUiState(saveKey, () =>
              dashboard.saveCalendarAvailability(),
            )
          }
        >
          {dashboard.isPending(saveKey) ? 'Saving...' : 'Save Availability'}
        </CButton>
      </CCol>
    </CRow>
  );
}
