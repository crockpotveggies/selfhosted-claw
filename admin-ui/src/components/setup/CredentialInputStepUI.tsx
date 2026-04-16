import { useEffect, useState } from 'react';
import { CButton, CCallout, CFormInput, CFormLabel, CFormText } from '@coreui/react';
import { apiFetch } from '../../admin/api';

interface FieldDef {
  key: string;
  label: string;
  type: string;
  placeholder?: string;
  required?: boolean;
  patternHelp?: string;
}

interface CredentialInputStepUIProps {
  integrationName: string;
  completed: boolean;
  onSetupComplete?: () => void;
}

export function CredentialInputStepUI({
  integrationName,
  completed,
  onSetupComplete,
}: CredentialInputStepUIProps) {
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stepLabel, setStepLabel] = useState('');
  const [helpUrl, setHelpUrl] = useState('');

  useEffect(() => {
    void apiFetch<{
      label: string;
      helpUrl?: string;
      fields: FieldDef[];
    }>(
      `/api/admin/integrations/${integrationName}/setup/credentials/fields`,
    ).then((data) => {
      setFields(data.fields);
      setStepLabel(data.label);
      setHelpUrl(data.helpUrl || '');
    });
  }, [integrationName]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await apiFetch(
        `/api/admin/integrations/${integrationName}/setup/credentials`,
        { method: 'POST', body: JSON.stringify(values) },
      );
      const status = await apiFetch<{ completed: boolean }>(
        `/api/admin/integrations/${integrationName}/setup/status`,
      );
      if (status.completed) {
        onSetupComplete?.();
        return;
      }
      onSetupComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (completed) {
    return <CCallout color="success">Credentials configured.</CCallout>;
  }

  return (
    <div>
      {helpUrl && (
        <p className="small text-body-secondary">
          <a href={helpUrl} target="_blank" rel="noopener noreferrer">
            Where to find these credentials
          </a>
        </p>
      )}
      {fields.map((field) => (
        <div key={field.key} className="mb-3">
          <CFormLabel>
            {field.label}
            {field.required && <span className="text-danger ms-1">*</span>}
          </CFormLabel>
          <CFormInput
            type={field.type === 'password' ? 'password' : 'text'}
            placeholder={field.placeholder}
            value={values[field.key] || ''}
            onChange={(e) =>
              setValues({ ...values, [field.key]: e.target.value })
            }
          />
          {field.patternHelp && (
            <CFormText>{field.patternHelp}</CFormText>
          )}
        </div>
      ))}
      {error && (
        <CCallout color="danger" className="py-1 px-2 small">
          {error}
        </CCallout>
      )}
      <CButton color="primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Validate & Save'}
      </CButton>
    </div>
  );
}
