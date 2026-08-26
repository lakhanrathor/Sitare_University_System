import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, tokenStore } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    (async () => {
      if (!tokenStore.get()) {
        setLoading(false);
        return;
      }
      try {
        const { user: u } = await api.me();
        if (alive) setUser(u);
      } catch {
        tokenStore.clear();
      } finally {
        if (alive) setLoading(false);
      }
    })();

    // Raised by the API layer when a 401 comes back mid-session.
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);

    return () => {
      alive = false;
      window.removeEventListener('auth:expired', onExpired);
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const { token, user: u } = await api.login(email, password);
    tokenStore.set(token);
    setUser(u);
    return u;
  }, []);

  // Same shape as `login`: store the token, set the user, let the router's
  // own role-based redirect take it from there.
  const loginWithGoogle = useCallback(async (credential) => {
    const { token, user: u } = await api.googleLogin(credential);
    tokenStore.set(token);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, loginWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
