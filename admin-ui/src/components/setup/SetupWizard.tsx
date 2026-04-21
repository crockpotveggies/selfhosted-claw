import { CButton, CCallout } from '@coreui/react';
import {
  CheckCircleFill,
  CircleFill,
  ArrowRightCircle,
  ExclamationTriangleFill,
} from 'react-bootstrap-icons';

export interface SetupStepView {
  type: string;
  label: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  error?: string;
}

interface SetupWizardProps {
  steps: SetupStepView[];
  currentStep: number;
  children: React.ReactNode[];
  onStepClick?: (index: number) => void;
}

function stepIcon(
  status: SetupStepView['status'],
  isCurrent: boolean,
) {
  if (status === 'completed')
    return <CheckCircleFill size={16} className="text-success" />;
  if (status === 'error')
    return <ExclamationTriangleFill size={16} className="text-danger" />;
  if (isCurrent)
    return <ArrowRightCircle size={16} className="text-info" />;
  return <CircleFill size={10} className="text-body-tertiary" />;
}

export function SetupWizard({
  steps,
  currentStep,
  children,
  onStepClick,
}: SetupWizardProps) {
  const activeStep =
    children.length > 0
      ? Math.max(0, Math.min(currentStep, children.length - 1))
      : currentStep;

  return (
    <div className="setupWizard">
      {/* Step indicator */}
      <div className="setupSteps mb-3">
        {steps.map((step, i) => (
          <div
            key={i}
            className={`setupStep ${i === activeStep ? 'active' : ''} ${step.status}`}
            onClick={() => onStepClick?.(i)}
            style={{ cursor: onStepClick ? 'pointer' : 'default' }}
          >
            <span className="stepIcon">
              {stepIcon(step.status, i === activeStep)}
            </span>
            <span className="stepLabel">{step.label}</span>
            {step.error && (
              <CCallout color="danger" className="mt-1 py-1 px-2 small">
                {step.error}
              </CCallout>
            )}
          </div>
        ))}
      </div>

      {/* Current step content */}
      <div className="setupStepContent">
        {children[activeStep] || (
          <p className="text-body-secondary">
            Step {activeStep + 1} is not available yet.
          </p>
        )}
      </div>
    </div>
  );
}
