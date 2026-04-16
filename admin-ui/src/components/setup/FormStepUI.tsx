import { useEffect, useState } from 'react';
import { CButton, CCallout } from '@coreui/react';
import { apiFetch } from '../../admin/api';
import { SchemaForm } from '../SchemaForm';

interface FormStepUIProps {
  integrationName: string;
  stepIndex: number;
  completed: boolean;
  onSetupComplete?: () => void;
}

export function FormStepUI({
  integrationName,
  stepIndex,
  completed,
  onSetupComplete,
}: FormStepUIProps) {
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void apiFetch<{
      schema: Record<string, unknown>;
      defaults?: Record<string, unknown>;
    }>(
      `/api/admin/integrations/${integrationName}/setup/form/${stepIndex}/schema`,
    ).then((data) => {
      setSchema(data.schema);
      if (data.defaults) setValues(data.defaults);
    });
  }, [integrationName, stepIndex]);

  const handleSave = async () => {
    setSaving(true);
    setErrors({});
    try {
      await apiFetch(
        `/api/admin/integrations/${integrationName}/setup/form/${stepIndex}`,
        { method: 'POST', body: JSON.stringify(values) },
      );
      const status = await apiFetch<{ completed: boolean }>(
        `/api/admin/integrations/${integrationName}/setup/status`,
      );
      if (status.completed) {
        onSetupComplete?.();
      }
    } catch (err) {
      setErrors({
        _form: err instanceof Error ? err.message : 'Save failed',
      });
    } finally {
      setSaving(false);
    }
  };

  if (completed) {
    return <CCallout color="success">Configuration saved.</CCallout>;
  }

  if (!schema) return <p>Loading form...</p>;

  return (
    <div>
      <SchemaForm
        schema={schema as any}
        values={values}
        onChange={setValues}
        errors={errors}
      />
      {errors._form && (
        <CCallout color="danger" className="py-1 px-2 small mt-2">
          {errors._form}
        </CCallout>
      )}
      <CButton
        color="primary"
        onClick={handleSave}
        disabled={saving}
        className="mt-2"
      >
        {saving ? 'Saving...' : 'Save'}
      </CButton>
    </div>
  );
}
