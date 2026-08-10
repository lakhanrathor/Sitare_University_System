import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, Check, X, Repeat } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useSocketEvent } from '../../context/SocketContext';
import { shortDate } from '../../lib/timetable';
import { sectionLabel } from '../../lib/format';
import { Card, PageHeader, Spinner, Button, EmptyState, ErrorNote, Textarea } from '../../components/ui';

const STATUS_STYLE = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  accepted: 'bg-violet-50 text-violet-700 border-violet-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  declined: 'bg-rose-50 text-rose-700 border-rose-200',
  withdrawn: 'bg-slate-100 text-slate-500 border-slate-200',
};

/*
 * A swap clears two gates in order: the lecturer being asked, then an
 * administrator. Saying which one it is waiting on is the whole point of the
 * badge — "pending" alone leaves everyone wondering whose move it is.
 */
const STATUS_LABEL = {
  pending: 'Awaiting the other lecturer',
  accepted: 'Awaiting admin approval',
};

function Side({ side, who, tone }) {
  return (
    <div className={`flex-1 rounded-lg border p-3 ${tone}`}>
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{who}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">
        {side.subject ? `${side.subject.code} — ${side.subject.name}` : side.title}
      </p>
      {/* shortDate already carries the weekday, so `side.day` is not repeated. */}
      <p className="mt-0.5 text-xs text-slate-600">
        {sectionLabel(side.section)} · {shortDate(side.date)}
      </p>
      <p className="text-xs text-slate-500">{side.slotLabel}</p>
    </div>
  );
}

export default function Swaps() {
  const { user } = useAuth();
  const { notify } = useToast();
  const [swaps, setSwaps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setSwaps(await api.swaps());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useSocketEvent('swap:updated', load);

  const act = async (id, fn, title) => {
    setBusyId(id);
    try {
      const res = await fn();
      notify(res.message, { variant: 'success', title });
      setNoteFor(null);
      setNote('');
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Action failed' });
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Spinner label="Loading swap requests" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  // Both live stages belong under "awaiting decision" — neither is settled.
  const pending = swaps.filter((s) => ['pending', 'accepted'].includes(s.status));
  const settled = swaps.filter((s) => !['pending', 'accepted'].includes(s.status));

  const renderCard = (s) => (
    <Card key={s.id} className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-slate-900">{s.requestedBy.name}</span>
          <ArrowLeftRight className="h-3.5 w-3.5 text-slate-400" />
          <span className="font-medium text-slate-900">{s.counterparty.name}</span>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            STATUS_STYLE[s.status]
          } ${STATUS_LABEL[s.status] ? '' : 'capitalize'}`}
        >
          {STATUS_LABEL[s.status] || s.status}
        </span>
      </div>

      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <Side side={s.from} who="Requester's class" tone="border-slate-200 bg-white" />
        <div className="grid shrink-0 place-items-center">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-violet-100 text-violet-700">
            <Repeat className="h-3.5 w-3.5" />
          </span>
        </div>
        <Side side={s.to} who="Their class" tone="border-slate-200 bg-white" />
      </div>

      {s.reason && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span className="font-medium text-slate-700">Reason:</span> {s.reason}
        </p>
      )}

      {s.status === 'approved' && (
        <p className="mt-3 text-xs text-emerald-700">
          Applied to the timetable — each class now runs in the other's period, with attendance and
          lecturer names moved accordingly.
        </p>
      )}
      {/* The first gate is cleared; say so, and say what is left. */}
      {s.status === 'accepted' && (
        <p className="mt-3 text-xs text-violet-700">
          {s.counterparty.name} has agreed. Nothing moves on the timetable until an administrator
          approves it.
        </p>
      )}
      {s.decidedBy && !['pending', 'accepted'].includes(s.status) && (
        <p className="mt-2 text-xs text-slate-500">
          {s.status === 'declined' ? 'Declined' : `${s.status} by ${s.decidedBy}`}
          {s.decisionNote ? ` — ${s.decisionNote}` : ''}
        </p>
      )}

      {(s.canApprove || s.canReject || s.canWithdraw || s.canDecline || s.canAccept) && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          {noteFor === s.id && (
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note (optional)"
              className="mb-2"
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {s.canWithdraw && (
              <Button
                variant="secondary"
                size="sm"
                loading={busyId === s.id}
                onClick={() => act(s.id, () => api.withdrawSwap(s.id), 'Swap withdrawn')}
              >
                Withdraw
              </Button>
            )}
            {s.canDecline && (
              <Button
                variant="danger"
                size="sm"
                loading={busyId === s.id}
                onClick={() => act(s.id, () => api.declineSwap(s.id), 'Swap declined')}
              >
                <X className="h-3.5 w-3.5" />
                Decline
              </Button>
            )}
            {/* Stage one: the lecturer being asked agrees. */}
            {s.canAccept && (
              <Button
                size="sm"
                loading={busyId === s.id}
                onClick={() => act(s.id, () => api.acceptSwap(s.id), 'Swap accepted')}
              >
                <Check className="h-3.5 w-3.5" />
                Accept
              </Button>
            )}
            {s.canReject && (
              <Button
                variant="danger"
                size="sm"
                loading={busyId === s.id}
                onClick={() => {
                  if (noteFor !== s.id) return setNoteFor(s.id);
                  act(s.id, () => api.decideSwap(s.id, false, note), 'Swap rejected');
                }}
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </Button>
            )}
            {/* Stage two, and only once stage one is done. */}
            {s.canApprove && (
              <Button
                size="sm"
                loading={busyId === s.id}
                onClick={() => act(s.id, () => api.decideSwap(s.id, true, note), 'Swap approved')}
              >
                <Check className="h-3.5 w-3.5" />
                Approve &amp; apply
              </Button>
            )}
            {/* An admin looking at a request the lecturer has not answered. */}
            {s.canReject && !s.canApprove && (
              <span className="self-center text-xs text-slate-500">
                Waiting on {s.counterparty.name} before this can be approved
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Class swaps"
        subtitle={
          user?.role === 'admin'
            ? 'Approve exchanges before they reach the live timetable'
            : 'Exchanges you have requested or been asked to accept'
        }
      />

      {swaps.length === 0 ? (
        <Card>
          <EmptyState
            icon={Repeat}
            title="No swap requests"
            description="Open a class on the timetable and choose “Swap with staff” to request one."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <section>
              <h2 className="mb-2.5 text-sm font-semibold text-slate-900">
                Awaiting decision{' '}
                <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                  {pending.length}
                </span>
              </h2>
              <div className="space-y-3">{pending.map(renderCard)}</div>
            </section>
          )}
          {settled.length > 0 && (
            <section>
              <h2 className="mb-2.5 text-sm font-semibold text-slate-900">History</h2>
              <div className="space-y-3">{settled.map(renderCard)}</div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
