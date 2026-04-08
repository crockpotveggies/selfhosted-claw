import { useAdminDashboardContext } from '../admin/context';

export function PolicyPage() {
  const dashboard = useAdminDashboardContext();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pauseKey = 'policy-pause';
  const resumeKey = 'policy-resume';
  const resolveKey = 'contact-resolve';
  const addVerifiedKey = 'verified-add';
  const saveCalendarKey = 'calendar-availability-save';
  const saveSettingsKey = 'settings-save';
  const saveSignalProfileKey = 'signal-profile-save';

  return (
    <section className="panelGrid">
      <div className="panel">
        <h2>Provider Controls</h2>
        <p>
          Paused providers:{' '}
          {dashboard.policy.pausedProviders.length
            ? dashboard.policy.pausedProviders.join(', ')
            : 'none'}
        </p>
        <div className="buttonRow">
          <input
            value={dashboard.providerInput}
            onChange={(event) => dashboard.setProviderInput(event.target.value)}
            placeholder="signal, sms, email"
          />
          <button
            disabled={dashboard.isPending(pauseKey)}
            onClick={() =>
              void dashboard.runWithUiState(pauseKey, () =>
                dashboard.mutate('policy.pauseProvider', {
                  provider: dashboard.providerInput,
                }),
              )
            }
          >
            {dashboard.isPending(pauseKey) ? 'Pausing...' : 'Pause'}
          </button>
          <button
            disabled={dashboard.isPending(resumeKey)}
            onClick={() =>
              void dashboard.runWithUiState(resumeKey, () =>
                dashboard.mutate('policy.resumeProvider', {
                  provider: dashboard.providerInput,
                }),
              )
            }
          >
            {dashboard.isPending(resumeKey) ? 'Resuming...' : 'Resume'}
          </button>
        </div>

        <h3>Availability</h3>
        <ul className="plainList">
          <li>
            OneCLI gateway:{' '}
            {dashboard.providers.onecliReachable
              ? 'reachable'
              : dashboard.providers.onecliConfigured
                ? 'configured but unreachable'
                : 'not configured'}
          </li>
          <li>
            Google Contacts:{' '}
            {dashboard.providers.googleContactsAvailable
              ? 'available'
              : 'not available'}
            {dashboard.providers.googleContactsAvailable
              ? ` (${dashboard.providers.googleContactsSource})`
              : ''}
          </li>
          <li>
            Signal outbound:{' '}
            {dashboard.providers.signalOutboundAvailable ? 'available' : 'not available'}
          </li>
          <li>
            SMS outbound:{' '}
            {dashboard.providers.smsOutboundAvailable ? 'available' : 'not available'}
          </li>
          <li>
            Email outbound:{' '}
            {dashboard.providers.emailOutboundAvailable ? 'available' : 'not available'}
          </li>
        </ul>

        <h3>Contact Resolution Preview</h3>
        <div className="buttonRow">
          <select
            value={dashboard.resolutionChannel}
            onChange={(event) =>
              dashboard.setResolutionChannel(
                event.target.value as 'signal' | 'sms' | 'email',
              )
            }
          >
            <option value="signal">Signal</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
          <input
            value={dashboard.resolutionQuery}
            onChange={(event) => dashboard.setResolutionQuery(event.target.value)}
            placeholder="Sam, sam@example.com, +15555550123"
          />
          <button
            disabled={dashboard.isPending(resolveKey)}
            onClick={() =>
              void dashboard.runWithUiState(resolveKey, () =>
                dashboard.previewResolution(),
              )
            }
          >
            {dashboard.isPending(resolveKey) ? 'Resolving...' : 'Resolve'}
          </button>
        </div>
        {dashboard.resolutionPreview ? (
          <p>
            {dashboard.resolutionPreview.displayName} →{' '}
            {dashboard.resolutionPreview.resolvedTarget} via{' '}
            {dashboard.resolutionPreview.source}
            {dashboard.resolutionPreview.existingConversation
              ? ' (existing conversation)'
              : ''}
          </p>
        ) : (
          <p>Resolve a name before trusting the agent with your social life.</p>
        )}

        <h3>Verified identities</h3>
        <div className="buttonRow">
          <input
            value={dashboard.verifiedIdentityInput}
            onChange={(event) => dashboard.setVerifiedIdentityInput(event.target.value)}
            placeholder="phone:+15555550123"
          />
          <input
            value={dashboard.verifiedLabelInput}
            onChange={(event) => dashboard.setVerifiedLabelInput(event.target.value)}
            placeholder="Label"
          />
          <button
            disabled={dashboard.isPending(addVerifiedKey)}
            onClick={() =>
              void dashboard.runWithUiState(addVerifiedKey, () =>
                dashboard.addVerifiedIdentity(),
              )
            }
          >
            {dashboard.isPending(addVerifiedKey) ? 'Adding...' : 'Add'}
          </button>
        </div>
        <ul className="plainList">
          {dashboard.verifiedIdentities.map((item) => (
            <li key={item.identity}>
              <span>
                {item.label}: {item.identity}
              </span>
              <button
                disabled={dashboard.isPending(`verified-remove:${item.identity}`)}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Remove verified identity "${item.label}" from the trust list?`,
                    )
                  ) {
                    return;
                  }
                  void dashboard.runWithUiState(`verified-remove:${item.identity}`, () =>
                    dashboard.mutate('verified.remove', { identity: item.identity }),
                  );
                }}
              >
                {dashboard.isPending(`verified-remove:${item.identity}`)
                  ? 'Removing...'
                  : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel">
        <h2>Calendar Availability</h2>
        <p className="mutedNote">
          Set your general availability. The agent will only propose meeting times
          within these windows.
        </p>
        <label>
          Timezone
          <input
            value={dashboard.calAvailTimezone}
            onChange={(event) => dashboard.setCalAvailTimezone(event.target.value)}
            placeholder="America/New_York"
          />
        </label>

        <h3>Availability Windows</h3>
        {dashboard.calAvailWindows.map((window, idx) => (
          <div
            key={`${window.startTime}-${window.endTime}-${idx}`}
            style={{
              marginBottom: '0.5rem',
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {dayNames.map((name, dayIdx) => (
              <label
                key={dayIdx}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.2rem',
                  fontSize: '0.85rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={window.days.includes(dayIdx)}
                  onChange={(event) => {
                    const updated = [...dashboard.calAvailWindows];
                    updated[idx] = {
                      ...window,
                      days: event.target.checked
                        ? [...window.days, dayIdx].sort()
                        : window.days.filter((day) => day !== dayIdx),
                    };
                    dashboard.setCalAvailWindows(updated);
                  }}
                />
                {name}
              </label>
            ))}
            <input
              type="time"
              value={window.startTime}
              onChange={(event) => {
                const updated = [...dashboard.calAvailWindows];
                updated[idx] = { ...window, startTime: event.target.value };
                dashboard.setCalAvailWindows(updated);
              }}
              style={{ width: '7rem' }}
            />
            <span>to</span>
            <input
              type="time"
              value={window.endTime}
              onChange={(event) => {
                const updated = [...dashboard.calAvailWindows];
                updated[idx] = { ...window, endTime: event.target.value };
                dashboard.setCalAvailWindows(updated);
              }}
              style={{ width: '7rem' }}
            />
            <button
              disabled={dashboard.isPending(`calendar-window-remove:${idx}`)}
              onClick={() =>
                {
                  if (!window.confirm('Remove this availability window?')) return;
                  dashboard.setCalAvailWindows(
                    dashboard.calAvailWindows.filter((_, index) => index !== idx),
                  );
                }
              }
            >
              Remove
            </button>
          </div>
        ))}
        <div className="buttonRow">
          <button
            onClick={() =>
              dashboard.setCalAvailWindows([
                ...dashboard.calAvailWindows,
                { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
              ])
            }
          >
            Add window
          </button>
        </div>

        <label>
          Additional notes
          <textarea
            value={dashboard.calAvailNotes}
            onChange={(event) => dashboard.setCalAvailNotes(event.target.value)}
            placeholder="e.g. No meetings before 10am on Mondays. Prefer afternoons."
            rows={3}
            style={{ width: '100%' }}
          />
        </label>
        <button
          disabled={dashboard.isPending(saveCalendarKey)}
          onClick={() =>
            void dashboard.runWithUiState(saveCalendarKey, () =>
              dashboard.saveCalendarAvailability(),
            )
          }
        >
          {dashboard.isPending(saveCalendarKey)
            ? 'Saving availability...'
            : 'Save availability'}
        </button>
      </div>

      <div className="panel">
        <h2>Control Settings</h2>
        <label>
          Control Signal chat JID
          <input
            value={dashboard.settingsDraft.controlSignalJid}
            onChange={(event) =>
              dashboard.setSettingsDraft({
                ...dashboard.settingsDraft,
                controlSignalJid: event.target.value,
              })
            }
          />
        </label>
        <label>
          Assistant Signal identity
          <input
            value={dashboard.settingsDraft.assistantSignalIdentity}
            onChange={(event) =>
              dashboard.setSettingsDraft({
                ...dashboard.settingsDraft,
                assistantSignalIdentity: event.target.value,
              })
            }
          />
        </label>
        <button
          disabled={dashboard.isPending(saveSettingsKey)}
          onClick={() =>
            void dashboard.runWithUiState(saveSettingsKey, () =>
              dashboard.saveSettings(dashboard.settingsDraft),
            )
          }
        >
          {dashboard.isPending(saveSettingsKey) ? 'Saving settings...' : 'Save settings'}
        </button>

        <h2>Signal Profile</h2>
        <label>
          Signal account
          <input
            value={dashboard.signalProfileDraft.account}
            onChange={(event) =>
              dashboard.setSignalProfileDraft({
                ...dashboard.signalProfileDraft,
                account: event.target.value,
              })
            }
            placeholder="+15555550123"
          />
        </label>
        <label>
          Profile name
          <input
            value={dashboard.signalProfileDraft.name}
            onChange={(event) =>
              dashboard.setSignalProfileDraft({
                ...dashboard.signalProfileDraft,
                name: event.target.value,
              })
            }
          />
        </label>
        <label>
          About
          <input
            value={dashboard.signalProfileDraft.about}
            onChange={(event) =>
              dashboard.setSignalProfileDraft({
                ...dashboard.signalProfileDraft,
                about: event.target.value,
              })
            }
          />
        </label>
        <label>
          Avatar image
          <input
            type="file"
            accept="image/*"
            onChange={(event) => void dashboard.handleSignalAvatarSelected(event)}
          />
        </label>
        <p>
          Uploaded images are center-cropped and resized to 512x512 PNG before being
          sent to Signal.
        </p>
        {dashboard.signalProfileDraft.avatarDataUrl ? (
          <div className="hintBox">
            <strong>Avatar preview</strong>
            <img
              src={dashboard.signalProfileDraft.avatarDataUrl}
              alt="Signal avatar preview"
              style={{
                width: '96px',
                height: '96px',
                objectFit: 'cover',
                borderRadius: '16px',
                display: 'block',
                marginTop: '0.75rem',
              }}
            />
            <div className="buttonRow">
              <button
                type="button"
                disabled={dashboard.isPending('signal-avatar-remove')}
                onClick={() =>
                  {
                    if (!window.confirm('Remove the current Signal avatar preview?')) {
                      return;
                    }
                    dashboard.setSignalProfileDraft((current) => ({
                      ...current,
                      avatarDataUrl: '',
                    }));
                  }
                }
              >
                Remove avatar
              </button>
            </div>
          </div>
        ) : null}
        <button
          disabled={dashboard.isPending(saveSignalProfileKey)}
          onClick={() =>
            void dashboard.runWithUiState(saveSignalProfileKey, () =>
              dashboard.saveSignalProfile(),
            )
          }
        >
          {dashboard.isPending(saveSignalProfileKey)
            ? 'Saving profile...'
            : 'Save Signal profile'}
        </button>
      </div>
    </section>
  );
}
