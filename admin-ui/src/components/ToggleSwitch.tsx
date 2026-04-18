interface ToggleSwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  ariaLabel: string;
}

export function ToggleSwitch({
  checked,
  disabled = false,
  onChange,
  ariaLabel,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`nc-switch${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!disabled) {
          onChange?.(!checked);
        }
      }}
    >
      <span className="nc-switch-track" />
      <span className="nc-switch-thumb" />
    </button>
  );
}
