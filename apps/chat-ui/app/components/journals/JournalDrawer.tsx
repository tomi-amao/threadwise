/**
 * JournalDrawer: one journal, line by line, with where it came from, and the way to take a
 * posted one back out of the books.
 */

import { useState } from 'react';
import { Link, useFetcher } from 'react-router';
import { toast } from 'sonner';
import { ArrowSquareOut } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Drawer } from '~/components/ui/drawer';
import type { JournalDetail } from '~/lib/api/journals.server';
import { STATUS, money, shortDate, sourceLabel, sourceLink, typeLabel } from './model';

export function JournalDrawer({
  detail,
  open,
  onClose,
}: {
  detail: JournalDetail | null;
  open: boolean;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; message?: string }>();
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== 'idle';

  const reverse = () => {
    if (!detail) return;
    const form = new FormData();
    form.set('intent', 'reverse');
    form.set('journalId', detail.id);
    fetcher.submit(form, { method: 'POST' });
  };
  // React to the result once per submission.
  const result = fetcher.state === 'idle' ? fetcher.data : undefined;
  const [handled, setHandled] = useState<unknown>(null);
  if (result && handled !== result) {
    setHandled(result);
    if (result.ok) {
      toast.success(result.message ?? 'Done');
      setConfirming(false);
    }
  }

  const link = detail ? sourceLink(detail.sourceType, detail.sourceId) : null;
  const balanced = detail ? Math.abs(detail.totalDebit - detail.totalCredit) < 0.005 : true;

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={o => !o && onClose()}
        eyebrow={detail ? `${typeLabel(detail.type)}, ${shortDate(detail.date)}` : 'Journal'}
        title={detail ? detail.description || 'Journal' : 'Journal not found'}
        description="The lines of this journal"
        className="w-[min(600px,100vw)]"
      >
        {!detail ? (
          <p className="text-[15px] text-text-2">
            This journal does not exist, or belongs to another business.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={STATUS[detail.status].tone} dot>
                {STATUS[detail.status].label}
              </Chip>
              <Chip tone="plain">{sourceLabel(detail.sourceType)}</Chip>
              {link && (
                <Link
                  to={link}
                  className="inline-flex items-center gap-1 rounded-sm text-[14px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  See the source <ArrowSquareOut size={13} aria-hidden />
                </Link>
              )}
            </div>

            <table className="w-full border-collapse text-[15px]" aria-label="Journal lines">
              <thead>
                <tr className="eyebrow text-left">
                  <th className="pb-2 font-normal">Account</th>
                  <th className="pb-2 text-right font-normal">Debit</th>
                  <th className="pb-2 text-right font-normal">Credit</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map(l => (
                  <tr key={l.id} className="border-t">
                    <td className="py-2.5 pr-3">
                      <span className="font-mono text-xs text-text-2">{l.accountNumber}</span>{' '}
                      {l.accountName}
                      {l.memo && <div className="text-[13px] text-text-2">{l.memo}</div>}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right tabular-nums">
                      {l.debit > 0 ? money(l.debit) : ''}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right tabular-nums">
                      {l.credit > 0 ? money(l.credit) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-t-foreground font-medium">
                  <td className="py-2.5">Total</td>
                  <td className="py-2.5 text-right tabular-nums">{money(detail.totalDebit)}</td>
                  <td className="py-2.5 pl-3 text-right tabular-nums">
                    {money(detail.totalCredit)}
                  </td>
                </tr>
              </tfoot>
            </table>
            {!balanced && (
              <p role="alert" className="text-[14px] text-destructive">
                This journal does not balance: debits and credits differ.
              </p>
            )}

            {detail.status === 'reversed' && (
              <p className="text-[14px] text-text-2">
                This journal was reversed, so it no longer counts in any total. It is kept for the
                record.
              </p>
            )}
            {detail.status === 'draft' && (
              <p className="text-[14px] text-text-2">
                This is a draft. It is not in any total until you choose its account on the Needs
                review tab and post it.
              </p>
            )}

            {detail.status === 'posted' && (
              <div className="rounded-xl border bg-background px-4 py-3.5">
                <p className="text-[14px] text-text-2">
                  A mistake? Reversing takes this journal out of every total. Nothing is deleted.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setConfirming(true)}
                >
                  Reverse this journal
                </Button>
                {fetcher.data && !fetcher.data.ok && !confirming && (
                  <p role="alert" className="mt-2 text-[14px] text-destructive">
                    {fetcher.data.error}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </Drawer>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse this journal?</DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.description || 'This journal'} (${money(detail.totalDebit)})`
                : ''}{' '}
              will stop counting in profit and loss, the balance sheet and tax. This cannot be
              undone from here.
            </DialogDescription>
          </DialogHeader>
          {fetcher.data && !fetcher.data.ok && (
            <p role="alert" className="text-[14px] text-destructive">
              {fetcher.data.error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </Button>
            <Button onClick={reverse} disabled={busy}>
              {busy ? 'Reversing…' : 'Reverse journal'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
