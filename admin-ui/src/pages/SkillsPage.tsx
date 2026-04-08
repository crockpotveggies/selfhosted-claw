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
    if (!window.confirm(`Delete skill "${dashboard.selectedSkillName}"?`)) return;
    void dashboard.runWithUiState(deleteKey, () =>
      dashboard.deleteSkill(dashboard.selectedSkillName!),
    );
  };

  return (
    <div className="skillsLayout">
      {/* Skill List */}
      <section className="panel skillListPanel">
        <div className="panelHeader">
          <h2>Container Skills</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              disabled={dashboard.isPending(refreshKey)}
              onClick={() =>
                void dashboard.runWithUiState(refreshKey, () =>
                  dashboard.skillsState.refresh(),
                )
              }
            >
              {dashboard.isPending(refreshKey) ? 'Refreshing...' : 'Refresh'}
            </button>
            <button className="btnPrimary" onClick={handleNew}>
              + New
            </button>
          </div>
        </div>
        <p className="mutedNote">
          Markdown skill files loaded into every agent container at{' '}
          <code>/workspace/skills</code>.
        </p>

        {dashboard.skillsState.loading ? (
          <p>Loading skills...</p>
        ) : dashboard.skillsState.error ? (
          <p className="mutedNote">{dashboard.skillsState.error}</p>
        ) : skills.length === 0 ? (
          <p className="mutedNote">No container skills defined yet.</p>
        ) : (
          <div className="skillList">
            {skills.map((skill) => (
              <button
                key={skill.name}
                className={`skillListItem ${
                  dashboard.selectedSkillName === skill.name ? 'active' : ''
                }`}
                onClick={() => handleSelect(skill.name)}
              >
                <strong>{skill.name}</strong>
                <span className="mutedNote">{skill.description}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Skill Editor */}
      <section className="panel skillEditorPanel">
        <div className="panelHeader">
          <h2>{isNew ? 'New Skill' : `Edit: ${dashboard.selectedSkillName}`}</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {!isNew && (
            <button
              className="btnDanger"
              disabled={dashboard.isPending(deleteKey)}
              onClick={handleDelete}
            >
              {dashboard.isPending(deleteKey) ? 'Deleting...' : 'Delete'}
            </button>
          )}
            <button
              className="btnPrimary"
              disabled={dashboard.isPending(saveKey)}
              onClick={handleSave}
            >
              {dashboard.isPending(saveKey)
                ? isNew
                  ? 'Creating...'
                  : 'Saving...'
                : isNew
                  ? 'Create'
                  : 'Save'}
            </button>
          </div>
        </div>

        {dashboard.skillDetailState.loading && !isNew ? (
          <p>Loading skill...</p>
        ) : (
          <div className="skillEditorFields">
            <label>
              Name (folder name)
              <input
                type="text"
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
            </label>
            <label>
              Description
              <input
                type="text"
                value={dashboard.skillEditorForm.description}
                onChange={(e) =>
                  dashboard.setSkillEditorForm((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                placeholder="Short description for the skill"
              />
            </label>
            <label>
              Content (Markdown)
              <textarea
                className="skillContentEditor"
                value={dashboard.skillEditorForm.content}
                onChange={(e) =>
                  dashboard.setSkillEditorForm((prev) => ({
                    ...prev,
                    content: e.target.value,
                  }))
                }
                placeholder="Skill instructions in Markdown..."
                rows={20}
              />
            </label>
          </div>
        )}
      </section>
    </div>
  );
}
