import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from './authStore';
import type { AuthScreenMode } from './authStore';
import { isValidEmail, passwordIssue, MAX_PASSWORD, MIN_PASSWORD } from './types';
import { BackButton, ErrorLine, Field, PrimaryButton, Sparkle, Strength } from './parts';

type Mode = AuthScreenMode;

interface AuthScreensProps {
  initialMode?: Mode;
  onCancel?: () => void;
}

export function AuthScreens({ initialMode = 'welcome', onCancel }: AuthScreensProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const clearError = useAuth((s) => s.clearError);

  const go = (m: Mode) => { clearError(); setMode(m); };

  return (
    <div className="ac">
      <div className="ac-blobs" aria-hidden><i /><i /><i /></div>
      <div className="ac-screen" key={mode}>
        {mode === 'welcome' && <Welcome onSignIn={() => go('signin')} onSignUp={() => go('signup')} onCancel={onCancel} />}
        {mode === 'signin' && <SignIn email={email} setEmail={setEmail} onBack={() => go('welcome')} onSwitch={() => go('signup')} />}
        {mode === 'signup' && <SignUp email={email} setEmail={setEmail} onBack={() => go('welcome')} onSwitch={() => go('signin')} />}
      </div>
    </div>
  );
}

function Welcome({ onSignIn, onSignUp, onCancel }: { onSignIn: () => void; onSignUp: () => void; onCancel?: () => void }) {
  const error = useAuth((s) => s.error);
  return (
    <div className="ac-welcome">
      <div className="ac-welcome-top"><Sparkle size={72} /></div>
      <div className="ac-welcome-body">
        <h1 className="ac-big">Welcome to <span>Apollo</span></h1>
        <p className="ac-sub center">Sign in to your account to continue. Your chats and settings stay with you.</p>
        <ErrorLine message={error?.message} />
        <button type="button" className="ac-btn" onClick={onSignUp}><span>Create account</span></button>
        <button type="button" className="ac-btn ghost" onClick={onSignIn}><span>I already have an account</span></button>
        {onCancel && <button type="button" className="ac-link" onClick={onCancel}>Volver a Apollo</button>}
      </div>
    </div>
  );
}

function SignIn(p: { email: string; setEmail: (v: string) => void; onBack: () => void; onSwitch: () => void }) {
  const { signIn, busy, error } = useAuth();
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const emailOk = isValidEmail(p.email);
  const canSubmit = emailOk && password.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    const ok = await signIn(p.email, password);
    if (!ok) setPassword('');
  };

  return (
    <form className="ac-form" onSubmit={submit} noValidate>
      <BackButton onClick={p.onBack} />
      <h1 className="ac-h">Sign in</h1>
      <p className="ac-sub">Welcome back. Enter your details.</p>
      <Field label="Email" type="email" inputMode="email" autoComplete="username" autoFocus value={p.email} onChange={p.setEmail}
        invalid={touched && !emailOk} hint={touched && !emailOk ? 'Enter a valid email address.' : undefined} />
      <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
      <ErrorLine message={error?.message} />
      <div className="ac-foot">
        <PrimaryButton busy={busy}>Sign in</PrimaryButton>
        <p className="ac-switch">New to Apollo? <button type="button" className="ac-link" onClick={p.onSwitch}>Create account</button></p>
      </div>
    </form>
  );
}

function SignUp(p: { email: string; setEmail: (v: string) => void; onBack: () => void; onSwitch: () => void }) {
  const { signUp, busy, error } = useAuth();
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [touched, setTouched] = useState(false);

  // El registro pide SOLO correo y contrasena. El nombre se pregunta en el
  // onboarding porque el backend no acepta ese campo en el registro.
  const emailOk = isValidEmail(p.email);
  const pwIssue = passwordIssue(password);
  const ready = emailOk && !pwIssue && agree;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    const ok = await signUp(p.email, password);
    if (!ok) setPassword('');
  };

  return (
    <form className="ac-form" onSubmit={submit} noValidate>
      <BackButton onClick={p.onBack} />
      <h1 className="ac-h">Create your account</h1>
      <p className="ac-sub">One account for all your Apollo devices.</p>
      <Field label="Email" type="email" inputMode="email" autoComplete="email" autoFocus value={p.email} onChange={p.setEmail}
        invalid={touched && !emailOk} hint={touched && !emailOk ? 'Enter a valid email address.' : undefined} />
      <Field label="Password" type="password" autoComplete="new-password" value={password} onChange={setPassword}
        invalid={touched && !!pwIssue} hint={touched && pwIssue ? pwIssue : `${MIN_PASSWORD}-${MAX_PASSWORD} characters.`} />
      <Strength password={password} />
      <label className="ac-check">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I agree to the Terms and Privacy Policy.</span>
      </label>
      <ErrorLine message={error?.message} />
      <div className="ac-foot">
        <PrimaryButton busy={busy} disabled={!ready && touched}>Create account</PrimaryButton>
        <p className="ac-switch">Already have an account? <button type="button" className="ac-link" onClick={p.onSwitch}>Sign in</button></p>
      </div>
    </form>
  );
}
