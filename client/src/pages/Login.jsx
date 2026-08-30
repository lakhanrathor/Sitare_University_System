import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';
import { api, tokenStore } from '../lib/api';
import { Button, Input, ErrorNote, Field } from '../components/ui';

// Same variable the provider in main.jsx reads. Checked again here so an
// unconfigured deployment quietly falls back to password-only login instead
// of rendering a Google button that can never actually work.
const GOOGLE_ENABLED = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

export default function Login() {
  const { login, loginWithGoogle } = useAuth();
  const [mode, setMode] = useState('signin'); // 'signin' | 'change'

  const [form, setForm] = useState(
    import.meta.env.DEV ? { email: 'admin@sitare.org', password: 'admin123' } : { email: '', password: '' }
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const [cpForm, setCpForm] = useState({
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [cpError, setCpError] = useState('');
  const [cpBusy, setCpBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setCp = (k) => (e) => setCpForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(form.email.trim(), form.password);
    } catch (err) {
      setError(err.message || 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async (credentialResponse) => {
    setError('');
    setGoogleBusy(true);
    try {
      await loginWithGoogle(credentialResponse.credential);
    } catch (err) {
      // The backend's message is already safe to show as-is (unregistered
      // account, disabled account, wrong domain) — never a raw token or a
      // stack trace, whatever actually went wrong on the server.
      setError(err.message || 'Google sign-in failed. Please try again.');
    } finally {
      setGoogleBusy(false);
    }
  };

  /*
   * There is no session yet at this point, so this can't just call the
   * protected change-password endpoint directly. It logs in with the
   * current password first (which also proves it's correct), uses that
   * token for the change, then signs in for real with the new password —
   * reusing the normal login flow for the redirect into the app.
   */
  const submitChangePassword = async (e) => {
    e.preventDefault();
    setCpError('');

    if (cpForm.newPassword.length < 6) {
      setCpError('New password must be at least 6 characters');
      return;
    }
    if (cpForm.newPassword !== cpForm.confirmPassword) {
      setCpError('New password and confirmation do not match');
      return;
    }
    if (cpForm.newPassword === cpForm.currentPassword) {
      setCpError('New password must be different from your current password');
      return;
    }

    setCpBusy(true);
    try {
      const { token } = await api.login(cpForm.email.trim(), cpForm.currentPassword);
      tokenStore.set(token);
      try {
        await api.changePassword(cpForm.currentPassword, cpForm.newPassword);
      } catch (err) {
        tokenStore.clear();
        throw err;
      }
      await login(cpForm.email.trim(), cpForm.newPassword);
    } catch (err) {
      setCpError(err.message || 'Could not change your password');
    } finally {
      setCpBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 text-center">
          <span className="mb-4 inline-grid h-12 w-12 place-items-center rounded-xl bg-indigo-600 text-white">
            <GraduationCap className="h-6 w-6" strokeWidth={2.2} />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Sitare University
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'signin' ? 'Sign in to the campus portal' : 'Set a new password'}
          </p>
        </div>

        {mode === 'signin' ? (
          <form
            onSubmit={submit}
            className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            {error && <ErrorNote>{error}</ErrorNote>}

            <Input
              id="email"
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="you@sitare.org"
              value={form.email}
              onChange={set('email')}
              required
            />
            <Input
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={form.password}
              onChange={set('password')}
              required
            />

            <Button type="submit" size="lg" loading={busy} className="w-full">
              {busy ? 'Signing in' : 'Sign in'}
            </Button>

            {GOOGLE_ENABLED && (
              <>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" />
                  OR
                  <span className="h-px flex-1 bg-slate-200" />
                </div>

                <div className="flex justify-center">
                  {googleBusy ? (
                    <p className="py-2 text-sm text-slate-500">Signing in…</p>
                  ) : (
                    <GoogleLogin
                      onSuccess={handleGoogle}
                      onError={() => setError('Google sign-in failed. Please try again.')}
                      text="continue_with"
                      width="304"
                    />
                  )}
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => {
                setError('');
                setCpForm((f) => ({ ...f, email: form.email }));
                setMode('change');
              }}
              className="w-full text-center text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              Change your password
            </button>
          </form>
        ) : (
          <form
            onSubmit={submitChangePassword}
            className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            {cpError && <ErrorNote>{cpError}</ErrorNote>}

            <Input
              id="cp-email"
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="you@sitare.org"
              value={cpForm.email}
              onChange={setCp('email')}
              required
            />
            <Input
              id="cp-current"
              label="Current password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={cpForm.currentPassword}
              onChange={setCp('currentPassword')}
              required
            />
            <Field label="New password" hint="At least 6 characters">
              <Input
                id="cp-new"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={cpForm.newPassword}
                onChange={setCp('newPassword')}
                required
              />
            </Field>
            <Input
              id="cp-confirm"
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={cpForm.confirmPassword}
              onChange={setCp('confirmPassword')}
              required
            />

            <Button type="submit" size="lg" loading={cpBusy} className="w-full">
              {cpBusy ? 'Updating' : 'Update password'}
            </Button>

            <button
              type="button"
              onClick={() => {
                setCpError('');
                setMode('signin');
              }}
              className="w-full text-center text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              Back to sign in
            </button>
          </form>
        )}

        <p className="mt-5 text-center text-xs text-slate-400">
          Use the account your institute issued you. Forgotten your password? Ask an
          administrator to reset it.
        </p>
      </div>
    </div>
  );
}
