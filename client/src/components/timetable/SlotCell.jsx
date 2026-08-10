import { useEffect, useRef } from 'react';
import { Plus, Clock, CalendarX2, ArrowRight } from 'lucide-react';
import {
  subjectStyle,
  ORIGIN_BADGE,
  KIND_LABEL,
  isGone,
  shortDate,
  sessionQualifier,
} from '../../lib/timetable';

/**
 * One cell of the grid: either the classes happening in that period, or an
 * empty period that staff can claim.
 */
export default function SlotCell({
  occurrences,
  canBook,
  onBook,
  onOpen,
  onEdit,
  currentUserId,
}) {
  const live = occurrences.filter((o) => !isGone(o));
  const gone = occurrences.filter(isGone);

  /*
   * A single click opens the actions, a double click opens the editor. The
   * first click of a double still fires, so opening the actions has to wait
   * long enough to learn which gesture this was.
   *
   * The wait has to outlast the system's own double-click interval, which is
   * 500ms on Windows by default. A shorter wait let the actions dialog open
   * between the two clicks, and its overlay then swallowed the second one — so
   * the double-click never arrived and the wrong window stayed up. Any gesture
   * the OS counts as a double is at most DOUBLE_CLICK_MS apart, so `detail`
   * always gets the chance to cancel the pending open first.
   *
   * Only an admin pays this wait, since only they have the second gesture; for
   * everyone else the dialog opens on the click. And the actions dialog offers
   * the editor outright, so a mistimed gesture is never a dead end.
   */
  const DOUBLE_CLICK_MS = 520;
  const clickTimer = useRef(null);

  useEffect(() => () => clearTimeout(clickTimer.current), []);

  const handleClick = (event, o) => {
    if (!onEdit) return onOpen?.(o);
    clearTimeout(clickTimer.current);
    // Any click after the first belongs to a double — let dblclick have it.
    if (event.detail > 1) return;
    clickTimer.current = setTimeout(() => onOpen?.(o), DOUBLE_CLICK_MS);
  };

  const handleDoubleClick = (o) => {
    clearTimeout(clickTimer.current);
    onEdit(o);
  };

  if (!occurrences.length) {
    if (!canBook) return <div className="h-full min-h-16" />;
    return (
      <button
        onClick={onBook}
        className="group flex h-full min-h-16 w-full items-center justify-center rounded-lg border border-dashed border-slate-200 text-slate-300 transition hover:border-indigo-400 hover:bg-indigo-50/50 hover:text-indigo-600"
        title="Book this free period"
      >
        <Plus className="h-4 w-4 opacity-0 transition group-hover:opacity-100" />
        <span className="sr-only">Book this free period</span>
      </button>
    );
  }

  return (
    <div className="flex h-full min-h-16 flex-col gap-1">
      {live.map((o) => {
        const s = subjectStyle(o.subject?.code);
        const badge = ORIGIN_BADGE[o.origin];
        const mine = o.faculty && currentUserId && o.faculty.id === currentUserId;
        const kindLabel = KIND_LABEL[o.kind];
        const qualifier = sessionQualifier(o);

        return (
          <button
            key={o.id}
            onClick={(e) => handleClick(e, o)}
            onDoubleClick={onEdit ? () => handleDoubleClick(o) : undefined}
            title={onEdit ? 'Double-click to correct this period' : undefined}
            /*
             * flex-1 so the card grows into the whole cell. A short class in a
             * tall row otherwise leaves dead space underneath, and a
             * double-click there hit the table rather than the class.
             * select-none stops the second click highlighting the text.
             */
            className={`flex w-full flex-1 flex-col justify-start rounded-lg border px-2 py-1.5 text-left transition select-none ${s.bg} ${
              mine ? 'border-indigo-400 ring-1 ring-indigo-200' : s.border
            } ${onOpen ? 'hover:shadow-sm' : 'cursor-default'}`}
          >
            <div className="flex items-start justify-between gap-1">
              <span className={`text-[11px] leading-tight font-semibold ${s.text}`}>
                {o.subject?.code || o.title}
              </span>
              {badge && (
                <span
                  className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold ${badge.cls}`}
                >
                  {badge.label}
                </span>
              )}
            </div>

            {o.subject && (
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-slate-600">
                {o.subject.name}
              </p>
            )}

            {o.faculty && (
              <p className="mt-1 truncate text-[10px] text-slate-500">{o.faculty.name}</p>
            )}

            {/* A stand-in was asked to mark this register. */}
            {o.attendanceBy && o.attendanceBy.id !== o.faculty?.id && (
              <p className="mt-0.5 truncate text-[10px] text-amber-700">
                Register: {o.attendanceBy.name}
              </p>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {qualifier && (
                <span className="rounded bg-white/70 px-1 py-px text-[9px] font-semibold text-slate-600 ring-1 ring-slate-200">
                  {qualifier}
                </span>
              )}
              {kindLabel && (
                <span className="inline-flex items-center gap-0.5 text-[9px] font-medium text-slate-400">
                  <Clock className="h-2.5 w-2.5" />
                  {kindLabel}
                </span>
              )}
            </div>
          </button>
        );
      })}

      {/* Tombstones keep the original period visible so nobody turns up to an empty room. */}
      {gone.map((o) => (
        <div
          key={o.id}
          className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-2 py-1.5"
          title={o.reason || undefined}
        >
          <div className="flex items-center gap-1">
            {o.origin === 'cancelled' ? (
              <CalendarX2 className="h-2.5 w-2.5 text-rose-400" />
            ) : (
              <ArrowRight className="h-2.5 w-2.5 text-slate-400" />
            )}
            <span className="text-[11px] leading-tight font-medium text-slate-400 line-through">
              {o.subject?.code || o.title}
            </span>
          </div>
          <p className="mt-0.5 text-[9px] leading-tight text-slate-400">
            {o.origin === 'cancelled'
              ? 'Cancelled'
              : `Moved to ${shortDate(o.movedTo.date)}, slot ${o.movedTo.slot}`}
          </p>
        </div>
      ))}

      {canBook && live.length === 0 && gone.length > 0 && (
        <button
          onClick={onBook}
          className="rounded-lg border border-dashed border-slate-200 py-1 text-[10px] text-slate-400 transition hover:border-indigo-400 hover:text-indigo-600"
        >
          + Use this period
        </button>
      )}
    </div>
  );
}
