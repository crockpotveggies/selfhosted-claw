import { useEffect, useState } from 'react';
import {
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CFormInput,
  CFormTextarea,
  CCallout,
} from '@coreui/react';

import { apiFetch } from '../admin/api';

interface ProfileField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'image';
  placeholder?: string;
}

interface IntegrationProfileCardProps {
  integrationName: string;
}

export function IntegrationProfileCard({
  integrationName,
}: IntegrationProfileCardProps) {
  const [label, setLabel] = useState('');
  const [fields, setFields] = useState<ProfileField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const data = await apiFetch<{
          label: string;
          fields: ProfileField[];
          values: Record<string, string>;
        }>(`/api/admin/integrations/${integrationName}/profile`);
        setLabel(data.label);
        setFields(data.fields);
        setValues(data.values);
      } catch {
        // No profile for this integration — don't render
      }
    })();
  }, [integrationName]);

  if (!label || fields.length === 0) return null;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await apiFetch(`/api/admin/integrations/${integrationName}/profile`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CCard className="mb-3">
      <CCardHeader>
        <strong>{label}</strong>
      </CCardHeader>
      <CCardBody>
        <div className="d-flex flex-column gap-3">
          {fields.map((field) => (
            <div key={field.key}>
              <label className="form-label small fw-semibold">
                {field.label}
              </label>
              {field.type === 'textarea' ? (
                <CFormTextarea
                  rows={3}
                  value={values[field.key] || ''}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setValues({ ...values, [field.key]: e.target.value })
                  }
                />
              ) : field.type === 'image' ? (
                <>
                  {values[field.key] && (
                    <div className="mb-2">
                      <img
                        src={values[field.key]}
                        alt={field.label}
                        style={{
                          width: 64,
                          height: 64,
                          objectFit: 'cover',
                          borderRadius: 12,
                        }}
                      />
                    </div>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="form-control form-control-sm"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        setValues({
                          ...values,
                          [field.key]: reader.result as string,
                        });
                      };
                      reader.readAsDataURL(file);
                    }}
                  />
                </>
              ) : (
                <CFormInput
                  size="sm"
                  value={values[field.key] || ''}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setValues({ ...values, [field.key]: e.target.value })
                  }
                />
              )}
            </div>
          ))}

          {error && (
            <CCallout color="danger" className="py-1 px-2 small">
              {error}
            </CCallout>
          )}
          {saved && (
            <CCallout color="success" className="py-1 px-2 small">
              Profile saved.
            </CCallout>
          )}
          <CButton
            size="sm"
            color="primary"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving...' : `Save ${label}`}
          </CButton>
        </div>
      </CCardBody>
    </CCard>
  );
}
