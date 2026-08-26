import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';
import { Button, Input, ErrorNote } from '../components/ui';

// Same variable the provider in main.jsx reads. Checked again here so an
// unconfigured deployment quietly falls back to password-only login instead
// of rendering a Google button that can never actually work.
const GOOGLE_ENABLED = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

export default function Login() {
  const { login, loginWithGoogle } = useAuth();
  const [form, setForm] = useState(
    import.meta.env.DEV ? { email: 'admin@sitare.org', password: 'admin123' } : { email: '', password: '' }
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

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
          <p className="mt-1 text-sm text-slate-500">Sign in to the campus portal</p>
        </div>

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
        </form>

        <p className="mt-5 text-center text-xs text-slate-400">
          Use the account your institute issued you. Forgotten your password? Ask an
          administrator to reset it.
        </p>
      </div>
    </div>
  );
}
