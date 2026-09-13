import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  GraduationCap, LogOut, CalendarCheck, LayoutGrid, Menu, X, CalendarDays, Repeat,
  Users, BookOpen, CalendarRange, FileText, CalendarClock,
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
    { to: '/exams', label: 'Exams', icon: CalendarClock },
    { to: '/leave', label: 'Leave', icon: CalendarRange },
  ],
  faculty: [
    { to: '/', label: 'My Subjects', icon: LayoutGrid, end: true },
    { to: '/timetable', label: 'Timetable', icon: CalendarDays },
    { to: '/notes', label: 'Notes', icon: FileText },
    { to: '/exams', label: 'Exams', icon: CalendarClock },
    { to: '/swaps', label: 'Swaps', icon: Repeat },
  ],
  admin: [
    { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true },
    { to: '/admin/people', label: 'People', icon: Users },
    { to: '/admin/academics', label: 'Academics', icon: BookOpen },
    { to: '/timetable', label: 'Timetable', icon: CalendarDays },
    { to: '/notes', label: 'Notes', icon: FileText },
    { to: '/exams', label: 'Exams', icon: CalendarClock },
    { to: '/swaps', label: 'Approvals', icon: Repeat },
  ],
};

const ROLE_LABEL = { student: 'Student', faculty: 'Faculty', admin: 'Administrator' };

/*
 * Staff are stored with the title they are addressed by ("Dr Anuja Agarwal",
 * "Mr Ajay Sonkar"), so the first word is often not a name at all — greeting
 * someone "Good morning, Mr" and stamping their avatar "MA" is worse than
 * having no personalisation. The title is dropped for both.
 */
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'smt']);

function nameParts(name = '') {
  const parts = name.split(' ').filter(Boolean);
  const stripped = parts.filter(
    (w) => !HONORIFICS.has(w.toLowerCase().replace(/\.$/, ''))
  );
  // A name that is *only* a title is not a name; keep what we were given.
  return stripped.length ? stripped : parts;
}

const firstName = (name = '') => nameParts(name)[0] || '';

/* Local time, so the greeting matches the clock the reader is looking at. */
function greetingFor(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function initials(name = '') {
  return nameParts(name)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/*
 * One nav row, shared by the fixed sidebar and the mobile drawer so the two
 * cannot drift apart. The active row is the only orange thing on screen: on a
 * deep violet panel it is the one element that has to be findable without
 * reading, and reserving the colour for exactly that keeps it meaning "you
 * are here" rather than becoming decoration.
 */
function NavRow({ link, onNavigate }) {
  return (
    <NavLink
      to={link.to}
      end={link.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
          isActive
            ? 'bg-accent-500 text-white shadow-lg shadow-accent-900/25'
            : 'text-indigo-100/80 hover:bg-white/10 hover:text-white'
        }`
      }
    >
      <link.icon className="h-4.5 w-4.5 shrink-0" strokeWidth={2} />
      <span className="truncate">{link.label}</span>
      {link.badge > 0 && (
        <span
          className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-white px-1.5 text-[11px] font-bold text-indigo-700"
          title={`${link.badge} waiting on you`}
        >
          {link.badge}
        </span>
      )}
    </NavLink>
  );
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

  // The drawer must not survive a navigation, or the next page opens covered.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const now = new Date();
  const greeting = greetingFor(now.getHours());
  const today = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const links = (NAV[user?.role] || []).map((l) =>
    l.to === '/swaps' ? { ...l, badge: swapsWaiting } : l
  );

  /* The week grid needs every pixel it can get; reading-width pages stay narrow. */
  const wide = pathname.startsWith('/timetable');

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const sidebar = (
    <>
      <Link to="/" className="flex items-center gap-3 px-2 py-1">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/15 text-white backdrop-blur">
          <GraduationCap className="h-5.5 w-5.5" strokeWidth={2.2} />
        </span>
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-tight text-white">Sitare</span>
          <span className="block text-[11px] font-medium text-indigo-200/70">University ERP</span>
        </span>
      </Link>

      <nav className="mt-7 flex flex-1 flex-col gap-1">
        {links.map((l) => (
          <NavRow key={l.to} link={l} onNavigate={() => setMenuOpen(false)} />
        ))}
      </nav>

      {/*
        The signed-in person, pinned to the bottom. On a shared machine in a
        staff room, "who am I posting as" is worth being able to check without
        opening a menu.
      */}
      <div className="mt-6 rounded-2xl bg-white/10 p-3 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-xs font-bold text-indigo-700">
            {initials(user?.name)}
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-white">{user?.name}</span>
            <span className="block truncate text-[11px] text-indigo-200/80">
              {user?.rollNumber || ROLE_LABEL[user?.role]}
            </span>
          </span>
        </div>
        <button
          onClick={handleLogout}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 py-2 text-xs font-semibold text-indigo-100 transition hover:bg-white/20 hover:text-white"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-full">
      {/* Fixed rail on a desktop; the drawer below covers everything narrower. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-gradient-to-b from-indigo-700 via-indigo-800 to-indigo-950 p-4 lg:flex">
        {sidebar}
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-indigo-950/50 backdrop-blur-[2px]"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="animate-slide-in absolute inset-y-0 left-0 flex w-64 flex-col bg-gradient-to-b from-indigo-700 via-indigo-800 to-indigo-950 p-4">
            {sidebar}
          </aside>
        </div>
      )}

      {/*
        min-w-0 overrides a flex item's default min-width: auto — without it, a
        wide child (the timetable grid) forces this flex item to grow past its
        own max-width instead of respecting it, and the whole page scrolls
        sideways rather than just the grid's own overflow-x-auto container.
      */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-canvas/80 backdrop-blur-md">
          <div
            className={`mx-auto flex h-16 w-full items-center justify-between gap-4 px-4 sm:px-6 ${
              wide ? 'max-w-[92rem]' : 'max-w-6xl'
            }`}
          >
            <button
              onClick={() => setMenuOpen(true)}
              className="rounded-xl p-2 text-slate-600 transition hover:bg-white lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/*
              The greeting is not decoration: on a shared staff machine it is
              the fastest way to notice you are looking at somebody else's
              session before you mark a register as them.
            */}
            <div className="hidden min-w-0 lg:block">
              <p className="truncate text-sm font-semibold text-slate-900">
                {greeting}, {firstName(user?.name)}
              </p>
              <p className="text-xs text-slate-500">{today}</p>
            </div>

            <div className="ml-auto flex items-center gap-3">
              {/* Live indicator — confirms the realtime channel is up. */}
              <span
                className="hidden items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-500 elev-1 sm:flex"
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
            </div>
          </div>
        </header>

        <main
          className={`mx-auto w-full min-w-0 flex-1 px-4 py-7 sm:px-6 sm:py-8 ${
            wide ? 'max-w-[92rem]' : 'max-w-6xl'
          }`}
        >
          <Outlet />
        </main>

        <footer className="px-4 py-6 sm:px-6">
          <p className="text-center text-xs text-slate-400">
            Attendance is calculated on classes actually conducted, not the semester plan.
          </p>
        </footer>
      </div>
    </div>
  );
}
