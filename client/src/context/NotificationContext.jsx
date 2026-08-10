import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import { useSocketEvent } from './SocketContext';
import { useToast } from './ToastContext';

const NotificationContext = createContext(null);

export function NotificationProvider({ children }) {
  const { user } = useAuth();
  const { notify } = useToast();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await api.notifications();
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      /* the bell is not worth interrupting the user for */
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnread(0);
      return;
    }
    load();
  }, [user, load]);

  // Server push: prepend without a refetch, and surface it as a toast.
  useSocketEvent('notification:new', (n) => {
    setItems((prev) => [{ ...n, read: false }, ...prev].slice(0, 30));
    setUnread((u) => u + 1);
    notify(n.message, {
      variant: n.requiresAction ? 'info' : 'info',
      title: n.title,
      duration: n.requiresAction ? 8000 : 5000,
    });
  });

  const markRead = useCallback(async (id) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api.markNotificationRead(id);
    } catch {
      /* optimistic; the next load reconciles */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try {
      await api.markAllNotificationsRead();
    } catch {
      /* optimistic */
    }
  }, []);

  return (
    <NotificationContext.Provider
      value={{ items, unread, loading, reload: load, markRead, markAllRead }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export const useNotifications = () => useContext(NotificationContext);
