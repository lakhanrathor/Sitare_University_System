import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, BellRing, BellOff, Loader2 } from 'lucide-react';
import { useNotifications } from '../context/NotificationContext';
import { pushState, enablePush, disablePush } from '../lib/push';

function timeAgo(iso) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function NotificationBell() {
  const { items, unread, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState('');
  const ref = useRef(null);
  const navigate = useNavigate();

  /*
   * Read when the panel opens, not on mount. Asking the browser about push on
   * every page load is work nobody asked for, and the answer can change
   * outside the app — permission is revoked from browser settings, not here.
   */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    pushState()
      .then((s) => alive && setPush(s))
      .catch(() => alive && setPush(null));
    return () => {
      alive = false;
    };
  }, [open]);

  const togglePush = async () => {
    setPushBusy(true);
    setPushError('');
    try {
      if (push?.subscribed) await disablePush();
      else await enablePush();
      setPush(await pushState());
    } catch (err) {
      setPushError(err.message);
      setPush(await pushState().catch(() => push));
    } finally {
      setPushBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n) => {
    if (!n.read) markRead(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      >
        <Bell className="h-4.5 w-4.5" />
        {unread > 0 && (
          <span className="nums absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="animate-fade-up absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
          </div>

          {/*
            Only where it can actually do something: a browser without push and
            a server without keys both render nothing rather than a control
            that cannot work. Blocked is the exception worth saying out loud,
            because the fix is somewhere this app cannot reach.
          */}
          {push?.supported && push.enabled && (
            <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-2">
              {push.permission === 'denied' ? (
                <p className="text-xs text-slate-500">
                  Notifications are blocked for this site — allow them in your browser settings to
                  get them on this device.
                </p>
              ) : (
                <button
                  onClick={togglePush}
                  disabled={pushBusy}
                  className="flex w-full items-center gap-2 text-left text-xs font-medium text-slate-600 transition hover:text-indigo-700 disabled:opacity-60"
                >
                  {pushBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : push.subscribed ? (
                    <BellRing className="h-3.5 w-3.5 text-indigo-600" />
                  ) : (
                    <BellOff className="h-3.5 w-3.5 text-slate-400" />
                  )}
                  {push.subscribed
                    ? 'This device gets notifications — turn off'
                    : 'Also notify me on this device'}
                </button>
              )}
              {pushError && <p className="mt-1 text-xs text-rose-600">{pushError}</p>}
            </div>
          )}

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">Nothing yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openItem(n)}
                      className={`flex w-full gap-3 px-4 py-3 text-left transition hover:bg-slate-50 ${
                        n.read ? '' : 'bg-indigo-50/40'
                      }`}
                    >
                      <span
                        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          n.read ? 'bg-transparent' : 'bg-indigo-500'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium text-slate-900">
                            {n.title}
                          </span>
                          <span className="shrink-0 text-[11px] text-slate-400">
                            {timeAgo(n.createdAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-slate-600">
                          {n.message}
                        </span>
                        {n.requiresAction && (
                          <span className="mt-1.5 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            Needs a decision
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
