import type { PersonalityScope } from '../admin/types';
import { useAdminDashboardContext } from '../admin/context';

export function PersonalityPage() {
  const dashboard = useAdminDashboardContext();

  return (
    <section className="panelGrid">
      <div className="panel">
        <div className="panelHeader">
          <h2>Personality</h2>
          <input
            value={dashboard.scope}
            onChange={(event) =>
              dashboard.setScope(event.target.value as PersonalityScope)
            }
            placeholder="global, main, or group:folder"
          />
        </div>
        <label>
          Display name
          <input
            value={dashboard.personalityForm.displayName}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                displayName: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          Role
          <input
            value={dashboard.personalityForm.role}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                role: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          Tone
          <input
            value={dashboard.personalityForm.tone}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                tone: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          Communication style
          <input
            value={dashboard.personalityForm.communicationStyle}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                communicationStyle: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          Initiative
          <input
            value={dashboard.personalityForm.initiative}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                initiative: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          About the agent
          <textarea
            rows={5}
            placeholder="The agent's own backstory and personality facts — where it 'lives', what it enjoys, quirks, fun facts. Used when people ask the agent about itself."
            value={dashboard.personalityForm.aboutAgent}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                aboutAgent: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          About the controller
          <textarea
            rows={5}
            placeholder="Facts about you — location, job, hobbies, preferences. The agent uses these to answer questions about you and personalize conversations."
            value={dashboard.personalityForm.aboutController}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                aboutController: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <label>
          Custom instructions
          <textarea
            rows={10}
            value={dashboard.personalityForm.customInstructions}
            onChange={(event) =>
              dashboard.setPersonalityForm({
                ...dashboard.personalityForm,
                customInstructions: event.target.value,
                scope: dashboard.scope,
              })
            }
          />
        </label>
        <div className="buttonRow">
          <button
            onClick={() =>
              void dashboard.mutate('personality.upsert', {
                ...dashboard.personalityForm,
                scope: dashboard.scope,
              })
            }
          >
            Save
          </button>
          <button
            onClick={() =>
              void dashboard.mutate('personality.reset', {
                scope: dashboard.scope,
              })
            }
          >
            Reset scope
          </button>
        </div>
      </div>
      <div className="panel">
        <h2>Rendered Preview</h2>
        <pre>{dashboard.preview}</pre>
      </div>
    </section>
  );
}
