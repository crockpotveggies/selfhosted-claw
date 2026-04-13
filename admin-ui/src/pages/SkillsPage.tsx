import { useState } from 'react';
import {
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CFormInput,
  CFormTextarea,
  CRow,
} from '@coreui/react';
import {
  PencilSquare,
  TrashFill,
  PlusCircle,
  ArrowClockwise,
  FileEarmarkCode,
} from 'react-bootstrap-icons';

import { useAdminDashboardContext } from '../admin/context';

export function SkillsPage() {
  const dashboard = useAdminDashboardContext();
  const skills = dashboard.skillsState.data?.skills || [];
  const isNew = dashboard.selectedSkillName === null;
  const refreshKey = 'skills-refresh';
  const saveKey = isNew
    ? 'skills-create'
    : `skills-save:${dashboard.selectedSkillName || 'new'}`;
  const deleteKey = `skills-delete:${dashboard.selectedSkillName || 'none'}`;
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSkills = searchQuery
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.description.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : skills;

  const handleNew = () => {
    dashboard.setSelectedSkillName(null);
    dashboard.setSkillEditorForm({ name: '', description: '', content: '' });
  };

  const handleSelect = (name: string) => {
    dashboard.setSelectedSkillName(name);
  };

  const handleSave = () => {
    const { name, description, content } = dashboard.skillEditorForm;
    if (!name.trim()) return;
    void dashboard.runWithUiState(saveKey, () =>
      dashboard.saveSkill(name.trim(), description.trim(), content),
    );
  };

  const handleDelete = () => {
    if (!dashboard.selectedSkillName) return;
    if (!window.confirm(`Delete skill "${dashboard.selectedSkillName}"?`))
      return;
    void dashboard.runWithUiState(deleteKey, () =>
      dashboard.deleteSkill(dashboard.selectedSkillName!),
    );
  };

  const hasSelection = isNew || Boolean(dashboard.selectedSkillName);

  return (
    <CRow className="g-3">
      {/* Left panel — skill list */}
      <CCol lg={5} xl={4}>
        <CCard>
          <CCardHeader className="d-flex justify-content-between align-items-center">
            <div className="d-flex align-items-center gap-2">
              <FileEarmarkCode size={16} />
              <strong>Skills</strong>
            </div>
            <div className="d-flex gap-1">
              <CButton
                size="sm"
                color="secondary"
                variant="ghost"
                disabled={dashboard.isPending(refreshKey)}
                onClick={() =>
                  void dashboard.runWithUiState(refreshKey, () =>
                    dashboard.skillsState.refresh(),
                  )
                }
              >
                <ArrowClockwise size={14} />
              </CButton>
              <CButton size="sm" color="primary" onClick={handleNew}>
                <PlusCircle size={14} className="me-1" />
                New
              </CButton>
            </div>
          </CCardHeader>
          <CCardBody className="p-3">
            <CFormInput
              size="sm"
              placeholder="Search skills..."
              className="mb-3"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <div
              className="d-flex flex-column gap-2"
              style={{ maxHeight: 520, overflowY: 'auto' }}
            >
              {dashboard.skillsState.loading ? (
                <p className="text-body-secondary small mb-0">Loading...</p>
              ) : dashboard.skillsState.error ? (
                <p className="text-danger small mb-0">
                  {dashboard.skillsState.error}
                </p>
              ) : filteredSkills.length === 0 ? (
                <p className="text-body-secondary small mb-0">
                  {searchQuery
                    ? 'No skills match your search.'
                    : 'No container skills defined yet.'}
                </p>
              ) : (
                filteredSkills.map((skill) => {
                  const isActive =
                    dashboard.selectedSkillName === skill.name;
                  return (
                    <CCard
                      key={skill.name}
                      className={isActive ? 'border-primary' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => handleSelect(skill.name)}
                    >
                      <CCardBody className="py-2 px-3">
                        <div className="fw-semibold small">{skill.name}</div>
                        {skill.description && (
                          <div className="text-body-secondary small">
                            {skill.description}
                          </div>
                        )}
                      </CCardBody>
                    </CCard>
                  );
                })
              )}
            </div>
          </CCardBody>
        </CCard>
      </CCol>

      {/* Right panel — editor or empty state */}
      <CCol lg={7} xl={8}>
        <CCard style={{ minHeight: 520 }}>
          {!hasSelection ? (
            <CCardBody className="d-flex flex-column align-items-center justify-content-center text-center h-100">
              <FileEarmarkCode
                size={48}
                className="text-body-tertiary mb-3"
              />
              <h5 className="text-body-secondary">Select a Skill</h5>
              <p
                className="text-body-tertiary small mb-0"
                style={{ maxWidth: 260 }}
              >
                Choose a skill from the list to edit its content, or create a
                new one.
              </p>
            </CCardBody>
          ) : (
            <>
              <CCardHeader className="d-flex justify-content-between align-items-center">
                <strong>
                  {isNew ? 'New Skill' : dashboard.selectedSkillName}
                </strong>
                <div className="d-flex gap-1">
                  {!isNew && (
                    <CButton
                      size="sm"
                      color="danger"
                      variant="outline"
                      disabled={dashboard.isPending(deleteKey)}
                      onClick={handleDelete}
                    >
                      <TrashFill size={12} className="me-1" />
                      {dashboard.isPending(deleteKey)
                        ? 'Deleting...'
                        : 'Delete'}
                    </CButton>
                  )}
                  <CButton
                    size="sm"
                    color="primary"
                    disabled={dashboard.isPending(saveKey)}
                    onClick={handleSave}
                  >
                    <PencilSquare size={12} className="me-1" />
                    {dashboard.isPending(saveKey)
                      ? isNew
                        ? 'Creating...'
                        : 'Saving...'
                      : isNew
                        ? 'Create'
                        : 'Save'}
                  </CButton>
                </div>
              </CCardHeader>
              <CCardBody>
                {dashboard.skillDetailState.loading && !isNew ? (
                  <p className="text-body-secondary small">Loading skill...</p>
                ) : (
                  <div className="d-flex flex-column gap-3">
                    <div>
                      <label className="form-label small fw-semibold">
                        Name
                      </label>
                      <CFormInput
                        size="sm"
                        value={dashboard.skillEditorForm.name}
                        onChange={(e) =>
                          dashboard.setSkillEditorForm((prev) => ({
                            ...prev,
                            name: e.target.value,
                          }))
                        }
                        placeholder="e.g. executive-assistant"
                        disabled={!isNew}
                      />
                    </div>
                    <div>
                      <label className="form-label small fw-semibold">
                        Description
                      </label>
                      <CFormInput
                        size="sm"
                        value={dashboard.skillEditorForm.description}
                        onChange={(e) =>
                          dashboard.setSkillEditorForm((prev) => ({
                            ...prev,
                            description: e.target.value,
                          }))
                        }
                        placeholder="Short description"
                      />
                    </div>
                    <div>
                      <label className="form-label small fw-semibold">
                        Content (Markdown)
                      </label>
                      <CFormTextarea
                        value={dashboard.skillEditorForm.content}
                        onChange={(e) =>
                          dashboard.setSkillEditorForm((prev) => ({
                            ...prev,
                            content: e.target.value,
                          }))
                        }
                        placeholder="Skill instructions in Markdown..."
                        rows={18}
                        style={{
                          fontFamily:
                            "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                          fontSize: '0.82rem',
                          lineHeight: 1.5,
                          resize: 'vertical',
                        }}
                      />
                    </div>
                  </div>
                )}
              </CCardBody>
            </>
          )}
        </CCard>
      </CCol>
    </CRow>
  );
}
