import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button, Input, ErrorNote } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
        </form>

        <p className="mt-5 text-center text-xs text-slate-400">
          Use the account your institute issued you. Forgotten your password? Ask an
          administrator to reset it.
        </p>
      </div>
    </div>
  );
}
