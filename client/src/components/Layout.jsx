import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  GraduationCap, LogOut, CalendarCheck, LayoutGrid, Menu, X, CalendarDays, Repeat,
  Users, BookOpen, CalendarRange, FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useSocket, useSocketEvent } from '../context/SocketContext';
import NotificationBell from './NotificationBell';

const NAV = {
  student: [
    { to: '/', label: 'My Attendance', icon: CalendarCheck, end: true },
    { to: '/timetable', label: 'Timetable', icon: CalendarDays },
    { to: '/notes', label: 'Notes', icon: FileText },
    { to: '/leave', label: 'Leave', icon: CalendarRange },
  ],
  faculty: [
    { to: '/', label: 'My Subjects', icon: LayoutGrid, end: true },
    { to: '/timetable', label: 'Timetable', icon: CalendarDays },
    { to: '/notes', label: 'Notes', icon: FileText },
    { to: '/swaps', label: 'Swaps', icon: Repeat },
  ],
  admin: [
    { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
    { to: '/admin/people', label: 'People', icon: Users },
    { to: '/admin/academics', label: 'Academics', icon: BookOpen },
    { to: '/timetable', label: 'Timetable', icon: CalendarDays },
    { to: '/notes', label: 'Notes', icon: FileText },
    { to: '/swaps', label: 'Approvals', icon: Repeat },
  ],
};

const ROLE_LABEL = { student: 'Student', faculty: 'Faculty', admin: 'Administrator' };

function initials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [swapsWaiting, setSwapsWaiting] = useState(0);

  /*
   * Swaps waiting on this person specifically — a lecturer being asked to
   * accept, or an admin with something ready to approve. Without a count on
   * the tab a teacher has no reason to open it, and a request can sit for days
   * while the requester assumes it was seen.
   */
  const countWaiting = useCallback(async () => {
    if (!user || user.role === 'student') return;
    try {
      const swaps = await api.swaps();
      setSwapsWaiting(swaps.filter((s) => s.canAccept || s.canApprove).length);
    } catch {
      /* the badge is never worth surfacing an error for */
    }
  }, [user]);

  useEffect(() => {
    countWaiting();
  }, [countWaiting]);

  // Recount the moment anything moves, rather than on the next page load.
  useSocketEvent('swap:updated', countWaiting);
  useSocketEvent('notification:new', (n) => {
    if (String(n.type || '').startsWith('swap:')) countWaiting();
  });

  const links = (NAV[user?.role] || []).map((l) =>
    l.to === '/swaps' ? { ...l, badge: swapsWaiting } : l
  );

  /* The week grid needs the extra width to show Mon-Fri without scrolling;
     the reading-width pages stay narrow. */
  const wide = pathname.startsWith('/timetable');
  const container = wide ? 'max-w-[88rem]' : 'max-w-6xl';

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur-md">
        <div
          className={`mx-auto flex h-16 ${container} items-center justify-between gap-4 px-4 sm:px-6`}
        >
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-600 text-white">
                <GraduationCap className="h-5 w-5" strokeWidth={2.2} />
              </span>
              <span className="leading-tight">
                <span className="block text-sm font-semibold tracking-tight text-slate-900">
                  Sitare University
                </span>
                <span className="block text-[11px] font-medium text-slate-500">
                  Campus Portal
                </span>
              </span>
            </Link>

            <nav className="hidden items-center gap-1 md:flex">
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`
                  }
                >
                  <l.icon className="h-4 w-4" />
                  {l.label}
                  {l.badge > 0 && (
                    <span
                      className="grid h-5 min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[11px] font-semibold text-white"
                      title={`${l.badge} waiting on you`}
                    >
                      {l.badge}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Live indicator — confirms the realtime channel is up. */}
            <span
              className="hidden items-center gap-1.5 text-xs font-medium text-slate-500 sm:flex"
              title={connected ? 'Live updates active' : 'Reconnecting…'}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connected ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'
                }`}
              />
              {connected ? 'Live' : 'Offline'}
            </span>

            <NotificationBell />

            <div className="hidden items-center gap-2.5 border-l border-slate-200 pl-3 sm:flex">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                {initials(user?.name)}
              </span>
              <span className="leading-tight">
                <span className="block max-w-40 truncate text-sm font-medium text-slate-900">
                  {user?.name}
                </span>
                <span className="block text-[11px] text-slate-500">
                  {user?.rollNumber || ROLE_LABEL[user?.role]}
                </span>
              </span>
            </div>

            <button
              onClick={handleLogout}
              className="hidden rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 sm:block"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4.5 w-4.5" />
            </button>

            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 sm:hidden"
              aria-label="Toggle menu"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="border-t border-slate-200 bg-white px-4 py-3 sm:hidden">
            <div className="mb-2 flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-white text-xs font-semibold text-slate-600">
                {initials(user?.name)}
              </span>
              <span className="leading-tight">
                <span className="block text-sm font-medium text-slate-900">{user?.name}</span>
                <span className="block text-[11px] text-slate-500">
                  {user?.rollNumber || ROLE_LABEL[user?.role]}
                </span>
              </span>
            </div>
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium ${
                    isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600'
                  }`
                }
              >
                <l.icon className="h-4 w-4" />
                {l.label}
                {l.badge > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[11px] font-semibold text-white">
                    {l.badge}
                  </span>
                )}
              </NavLink>
            ))}
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </header>

      <main className={`mx-auto w-full ${container} flex-1 px-4 py-7 sm:px-6 sm:py-9`}>
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 py-5">
        <p className="text-center text-xs text-slate-400">
          Attendance is calculated on classes actually conducted, not the semester plan.
        </p>
      </footer>
    </div>
  );
}
