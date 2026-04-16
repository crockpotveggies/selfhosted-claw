import { useState } from 'react';
import {
  CForm,
  CFormInput,
  CFormLabel,
  CFormSelect,
  CFormText,
  CFormTextarea,
  CInputGroup,
  CInputGroupText,
  CButton,
  CButtonGroup,
  CBadge,
} from '@coreui/react';

interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumLabels?: string[];
  minimum?: number;
  maximum?: number;
  items?: { type: string };
  format?: string;
  sensitive?: boolean;
  dependsOn?: { field: string; value: unknown };
}

interface SchemaFormProps {
  schema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}

export function SchemaForm({
  schema,
  values,
  onChange,
  errors = {},
  disabled = false,
}: SchemaFormProps) {
  const [tagInput, setTagInput] = useState<Record<string, string>>({});

  function updateField(key: string, value: unknown) {
    onChange({ ...values, [key]: value });
  }

  function isVisible(prop: JsonSchemaProperty): boolean {
    if (!prop.dependsOn) return true;
    return values[prop.dependsOn.field] === prop.dependsOn.value;
  }

  return (
    <CForm>
      {Object.entries(schema.properties).map(([key, prop]) => {
        if (!isVisible(prop)) return null;

        const fieldError = errors[key];
        const isRequired = schema.required?.includes(key);

        return (
          <div key={key} className="mb-3">
            {/* Boolean: switch */}
            {prop.type === 'boolean' ? (
              <>
                <CFormLabel htmlFor={`field-${key}`} className="d-block mb-2">
                  {prop.title}
                </CFormLabel>
                <CButtonGroup
                  id={`field-${key}`}
                  role="group"
                  aria-label={prop.title}
                >
                  <CButton
                    color={
                      Boolean(values[key] ?? prop.default)
                        ? 'primary'
                        : 'secondary'
                    }
                    variant={
                      Boolean(values[key] ?? prop.default)
                        ? undefined
                        : 'outline'
                    }
                    disabled={disabled}
                    onClick={() => updateField(key, true)}
                  >
                    On
                  </CButton>
                  <CButton
                    color={
                      !Boolean(values[key] ?? prop.default)
                        ? 'primary'
                        : 'secondary'
                    }
                    variant={
                      !Boolean(values[key] ?? prop.default)
                        ? undefined
                        : 'outline'
                    }
                    disabled={disabled}
                    onClick={() => updateField(key, false)}
                  >
                    Off
                  </CButton>
                </CButtonGroup>
                {prop.description && (
                  <CFormText className="d-block">{prop.description}</CFormText>
                )}
              </>
            ) : prop.type === 'string' && prop.enum ? (
              /* Enum: dropdown */
              <>
                <CFormLabel htmlFor={`field-${key}`}>
                  {prop.title}
                  {isRequired && <span className="text-danger ms-1">*</span>}
                </CFormLabel>
                <CFormSelect
                  id={`field-${key}`}
                  value={String(values[key] ?? prop.default ?? '')}
                  disabled={disabled}
                  onChange={(e) => updateField(key, e.target.value)}
                  invalid={Boolean(fieldError)}
                >
                  <option value="">Select...</option>
                  {prop.enum.map((val, i) => (
                    <option key={String(val)} value={String(val)}>
                      {prop.enumLabels?.[i] ?? String(val)}
                    </option>
                  ))}
                </CFormSelect>
                {prop.description && <CFormText>{prop.description}</CFormText>}
                {fieldError && (
                  <CFormText className="text-danger">{fieldError}</CFormText>
                )}
              </>
            ) : prop.type === 'string' && prop.format === 'textarea' ? (
              /* Textarea */
              <>
                <CFormLabel htmlFor={`field-${key}`}>
                  {prop.title}
                  {isRequired && <span className="text-danger ms-1">*</span>}
                </CFormLabel>
                <CFormTextarea
                  id={`field-${key}`}
                  rows={4}
                  value={String(values[key] ?? prop.default ?? '')}
                  disabled={disabled}
                  onChange={(e) => updateField(key, e.target.value)}
                />
                {prop.description && <CFormText>{prop.description}</CFormText>}
              </>
            ) : prop.type === 'string' ? (
              /* String input */
              <>
                <CFormLabel htmlFor={`field-${key}`}>
                  {prop.title}
                  {isRequired && <span className="text-danger ms-1">*</span>}
                </CFormLabel>
                <CFormInput
                  id={`field-${key}`}
                  type={
                    prop.sensitive
                      ? 'password'
                      : prop.format === 'url'
                        ? 'url'
                        : prop.format === 'email'
                          ? 'email'
                          : 'text'
                  }
                  value={String(values[key] ?? prop.default ?? '')}
                  placeholder={prop.description}
                  disabled={disabled}
                  onChange={(e) => updateField(key, e.target.value)}
                  invalid={Boolean(fieldError)}
                />
                {prop.description && <CFormText>{prop.description}</CFormText>}
                {fieldError && (
                  <CFormText className="text-danger">{fieldError}</CFormText>
                )}
              </>
            ) : prop.type === 'number' || prop.type === 'integer' ? (
              /* Number input */
              <>
                <CFormLabel htmlFor={`field-${key}`}>
                  {prop.title}
                  {isRequired && <span className="text-danger ms-1">*</span>}
                </CFormLabel>
                <CFormInput
                  id={`field-${key}`}
                  type="number"
                  min={prop.minimum}
                  max={prop.maximum}
                  step={prop.type === 'integer' ? 1 : undefined}
                  value={
                    values[key] != null
                      ? Number(values[key])
                      : prop.default != null
                        ? Number(prop.default)
                        : ''
                  }
                  disabled={disabled}
                  onChange={(e) =>
                    updateField(
                      key,
                      e.target.value === ''
                        ? undefined
                        : Number(e.target.value),
                    )
                  }
                  invalid={Boolean(fieldError)}
                />
                {prop.description && <CFormText>{prop.description}</CFormText>}
                {fieldError && (
                  <CFormText className="text-danger">{fieldError}</CFormText>
                )}
              </>
            ) : prop.type === 'array' && prop.items?.type === 'string' ? (
              /* Array of strings: tag input */
              <>
                <CFormLabel htmlFor={`field-${key}`}>
                  {prop.title}
                  {isRequired && <span className="text-danger ms-1">*</span>}
                </CFormLabel>
                <div className="mb-1">
                  {((values[key] as string[]) || []).map(
                    (tag: string, i: number) => (
                      <CBadge
                        key={i}
                        color="info"
                        className="me-1 mb-1"
                        style={{ cursor: disabled ? 'default' : 'pointer' }}
                        onClick={() => {
                          if (disabled) return;
                          const arr = [
                            ...((values[key] as string[]) || []),
                          ];
                          arr.splice(i, 1);
                          updateField(key, arr);
                        }}
                      >
                        {tag} {!disabled && 'x'}
                      </CBadge>
                    ),
                  )}
                </div>
                {!disabled && (
                  <CInputGroup size="sm">
                    <CFormInput
                      id={`field-${key}`}
                      value={tagInput[key] || ''}
                      placeholder="Add item..."
                      onChange={(e) =>
                        setTagInput({
                          ...tagInput,
                          [key]: e.target.value,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && tagInput[key]?.trim()) {
                          e.preventDefault();
                          const arr = [
                            ...((values[key] as string[]) || []),
                          ];
                          arr.push(tagInput[key].trim());
                          updateField(key, arr);
                          setTagInput({ ...tagInput, [key]: '' });
                        }
                      }}
                    />
                    <CButton
                      color="secondary"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!tagInput[key]?.trim()) return;
                        const arr = [
                          ...((values[key] as string[]) || []),
                        ];
                        arr.push(tagInput[key].trim());
                        updateField(key, arr);
                        setTagInput({ ...tagInput, [key]: '' });
                      }}
                    >
                      Add
                    </CButton>
                  </CInputGroup>
                )}
                {prop.description && <CFormText>{prop.description}</CFormText>}
              </>
            ) : null}
          </div>
        );
      })}
    </CForm>
  );
}
