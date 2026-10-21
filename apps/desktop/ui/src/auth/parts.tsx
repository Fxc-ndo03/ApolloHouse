import { useId, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { passwordStrength } from './types';

export function Sparkle({ size = 56 }: { size?: number }) {
  return (
    <span className="ac-spark" style={{ width: size, height: size }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="#fff" aria-hidden>
        <path d="M12 2l2.2 6.3L20.5 10l-6.3 1.7L12 18l-2.2-6.3L3.5 10l6.3-1.7z" />
      </svg>
    </span>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ac-back" onClick={onClick} aria-label="Back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
    </button>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  hint?: ReactNode;
}

export function Field({ label, value, onChange, invalid, hint, type, ...rest }: FieldProps) {
  const id = useId();
  const [show, setShow] = useState(false);
  const isPw = type === 'password';
  return (
    <div className="ac-field">
      <label htmlFor={id}>{label}</label>
      <div className={'ac-input' + (invalid ? ' bad' : '')}>
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} type={isPw && show ? 'text' : type}
          aria-invalid={invalid || undefined} spellCheck={false} autoCapitalize="none" {...rest} />
        {isPw && (
          <button type="button" className="ac-eye" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            {show ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {hint && <small className="ac-hint">{hint}</small>}
    </div>
  );
}

export function Strength({ password }: { password: string }) {
  const s = passwordStrength(password);
  const text = ['', 'Too short', 'Okay', 'Good', 'Strong'][s];
  return (
    <div className="ac-strength" aria-live="polite">
      <span className="bars">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= s ? 'on s' + s : ''} />)}</span>
      <small>{text}</small>
    </div>
  );
}

export function ErrorLine({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p className="ac-error" role="alert">{message}</p>;
}

export function PrimaryButton(p: { busy?: boolean; disabled?: boolean; children: ReactNode; type?: 'submit' | 'button'; onClick?: () => void; danger?: boolean }) {
  return (
    <button type={p.type ?? 'submit'} className={'ac-btn' + (p.danger ? ' danger' : '')} disabled={p.disabled || p.busy} onClick={p.onClick} aria-busy={p.busy || undefined}>
      {p.busy ? <i className="ac-spin" aria-hidden /> : null}
      <span>{p.children}</span>
    </button>
  );
}