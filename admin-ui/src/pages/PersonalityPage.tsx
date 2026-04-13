import {
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormInput,
  CFormSelect,
  CFormTextarea,
  CRow,
} from '@coreui/react';
import { PencilSquare, ArrowCounterclockwise } from 'react-bootstrap-icons';

import type { PersonalityScope } from '../admin/types';
import { useAdminDashboardContext } from '../admin/context';

export function PersonalityPage() {
  const dashboard = useAdminDashboardContext();
  const saveKey = 'personality-save';
  const resetKey = 'personality-reset';

  const updateField = (field: string, value: string) => {
    dashboard.setPersonalityForm({
      ...dashboard.personalityForm,
      [field]: value,
      scope: dashboard.scope,
    });
  };

  return (
    <CRow className="g-3">
      {/* Editor */}
      <CCol lg={7}>
        <CCard>
          <CCardHeader className="d-flex justify-content-between align-items-center">
            <strong>Personality</strong>
            <CFormSelect
              size="sm"
              style={{ width: 200 }}
              value={dashboard.scope}
              onChange={(e) =>
                dashboard.setScope(e.target.value as PersonalityScope)
              }
            >
              <option value="global">Global</option>
              <option value="main">Main group</option>
              {/* Group-specific scopes would be listed dynamically */}
            </CFormSelect>
          </CCardHeader>
          <CCardBody>
            <div className="d-flex flex-column gap-3">
              <div>
                <label className="form-label small fw-semibold">Display name</label>
                <CFormInput
                  size="sm"
                  value={dashboard.personalityForm.displayName}
                  onChange={(e) => updateField('displayName', e.target.value)}
                />
              </div>

              <CRow className="g-3">
                <CCol sm={6}>
                  <label className="form-label small fw-semibold">Role</label>
                  <CFormInput
                    size="sm"
                    value={dashboard.personalityForm.role}
                    onChange={(e) => updateField('role', e.target.value)}
                  />
                </CCol>
                <CCol sm={6}>
                  <label className="form-label small fw-semibold">Tone</label>
                  <CFormInput
                    size="sm"
                    value={dashboard.personalityForm.tone}
                    onChange={(e) => updateField('tone', e.target.value)}
                  />
                </CCol>
              </CRow>

              <CRow className="g-3">
                <CCol sm={6}>
                  <label className="form-label small fw-semibold">Communication style</label>
                  <CFormInput
                    size="sm"
                    value={dashboard.personalityForm.communicationStyle}
                    onChange={(e) => updateField('communicationStyle', e.target.value)}
                  />
                </CCol>
                <CCol sm={6}>
                  <label className="form-label small fw-semibold">Initiative</label>
                  <CFormInput
                    size="sm"
                    value={dashboard.personalityForm.initiative}
                    onChange={(e) => updateField('initiative', e.target.value)}
                  />
                </CCol>
              </CRow>

              <div>
                <label className="form-label small fw-semibold">About the agent</label>
                <CFormTextarea
                  rows={4}
                  placeholder="The agent's own backstory and personality facts — where it 'lives', what it enjoys, quirks, fun facts."
                  value={dashboard.personalityForm.aboutAgent}
                  onChange={(e) => updateField('aboutAgent', e.target.value)}
                />
              </div>

              <div>
                <label className="form-label small fw-semibold">About the controller</label>
                <CFormTextarea
                  rows={4}
                  placeholder="Facts about you — location, job, hobbies, preferences. The agent uses these to personalize conversations."
                  value={dashboard.personalityForm.aboutController}
                  onChange={(e) => updateField('aboutController', e.target.value)}
                />
              </div>

              <div>
                <label className="form-label small fw-semibold">Custom instructions</label>
                <CFormTextarea
                  rows={8}
                  value={dashboard.personalityForm.customInstructions}
                  onChange={(e) => updateField('customInstructions', e.target.value)}
                />
              </div>

              <div className="d-flex gap-2">
                <CButton
                  size="sm"
                  color="primary"
                  disabled={dashboard.isPending(saveKey)}
                  onClick={() =>
                    void dashboard.runWithUiState(saveKey, () =>
                      dashboard.mutate('personality.upsert', {
                        ...dashboard.personalityForm,
                        scope: dashboard.scope,
                      }),
                    )
                  }
                >
                  <PencilSquare size={12} className="me-1" />
                  {dashboard.isPending(saveKey) ? 'Saving...' : 'Save'}
                </CButton>
                <CButton
                  size="sm"
                  color="secondary"
                  variant="outline"
                  disabled={dashboard.isPending(resetKey)}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Reset the personality settings for "${dashboard.scope}"?`,
                      )
                    )
                      return;
                    void dashboard.runWithUiState(resetKey, () =>
                      dashboard.mutate('personality.reset', {
                        scope: dashboard.scope,
                      }),
                    );
                  }}
                >
                  <ArrowCounterclockwise size={12} className="me-1" />
                  {dashboard.isPending(resetKey) ? 'Resetting...' : 'Reset scope'}
                </CButton>
              </div>
            </div>
          </CCardBody>
        </CCard>
      </CCol>

      {/* Right column */}
      <CCol lg={5}>
        {/* Signal Profile */}
        <CCard className="mb-3">
          <CCardHeader>
            <strong>Signal Profile</strong>
          </CCardHeader>
          <CCardBody>
            <div className="d-flex flex-column gap-3">
              <div>
                <label className="form-label small fw-semibold">Signal account</label>
                <CFormInput
                  size="sm"
                  value={dashboard.signalProfileDraft.account}
                  onChange={(e) =>
                    dashboard.setSignalProfileDraft({
                      ...dashboard.signalProfileDraft,
                      account: e.target.value,
                    })
                  }
                  placeholder="+15555550123"
                />
              </div>
              <div>
                <label className="form-label small fw-semibold">Profile name</label>
                <CFormInput
                  size="sm"
                  value={dashboard.signalProfileDraft.name}
                  onChange={(e) =>
                    dashboard.setSignalProfileDraft({
                      ...dashboard.signalProfileDraft,
                      name: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label className="form-label small fw-semibold">About</label>
                <CFormInput
                  size="sm"
                  value={dashboard.signalProfileDraft.about}
                  onChange={(e) =>
                    dashboard.setSignalProfileDraft({
                      ...dashboard.signalProfileDraft,
                      about: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label className="form-label small fw-semibold">Avatar image</label>
                <input
                  type="file"
                  accept="image/*"
                  className="form-control form-control-sm"
                  onChange={(e) => void dashboard.handleSignalAvatarSelected(e)}
                />
                <div className="small text-body-secondary mt-1">
                  Center-cropped and resized to 512x512 PNG.
                </div>
              </div>
              {dashboard.signalProfileDraft.avatarDataUrl && (
                <div className="d-flex align-items-center gap-3">
                  <img
                    src={dashboard.signalProfileDraft.avatarDataUrl}
                    alt="Avatar preview"
                    style={{
                      width: 64,
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 12,
                    }}
                  />
                  <CButton
                    size="sm"
                    color="secondary"
                    variant="outline"
                    onClick={() => {
                      if (!window.confirm('Remove avatar preview?')) return;
                      dashboard.setSignalProfileDraft((c) => ({ ...c, avatarDataUrl: '' }));
                    }}
                  >
                    Remove
                  </CButton>
                </div>
              )}
              <CButton
                size="sm"
                color="primary"
                disabled={dashboard.isPending('signal-profile-save')}
                onClick={() =>
                  void dashboard.runWithUiState('signal-profile-save', () =>
                    dashboard.saveSignalProfile(),
                  )
                }
              >
                {dashboard.isPending('signal-profile-save') ? 'Saving...' : 'Save Signal Profile'}
              </CButton>
            </div>
          </CCardBody>
        </CCard>

        {/* Rendered Preview */}
        <CCard>
          <CCardHeader>
            <strong>Rendered Preview</strong>
          </CCardHeader>
          <CCardBody>
            <pre
              className="small mb-0"
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: '0.8rem',
                lineHeight: 1.5,
                maxHeight: 400,
                overflow: 'auto',
              }}
            >
              {dashboard.preview || 'No preview available for this scope.'}
            </pre>
          </CCardBody>
        </CCard>
      </CCol>
    </CRow>
  );
}
