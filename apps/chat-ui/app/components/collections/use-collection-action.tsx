/**
 * Submitting one of the collection page's actions: shows the result as a toast, hands back the
 * error for the form to show, and tells the caller when it worked (to close a drawer).
 */

import { useEffect, useRef } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';

export type ActionResult = { ok: boolean; message?: string; error?: string; id?: string };

export function useCollectionAction(onDone?: (result: ActionResult) => void) {
  const fetcher = useFetcher<ActionResult>();
  const handled = useRef<ActionResult | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== 'idle' || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      if (result.message) toast.success(result.message);
      done.current?.(result);
    }
  }, [fetcher.state, fetcher.data]);

  return {
    busy: fetcher.state !== 'idle',
    error: fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? 'That did not work') : null,
    submit: (fields: Record<string, string>) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      fetcher.submit(form, { method: 'POST' });
    },
  };
}

/** "Remove this?" with the consequence stated, used for every removal on the page. */
export function ConfirmRemove({
  open,
  title,
  description,
  confirmLabel = 'Remove',
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={o => !o && !busy && onCancel()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-[24px] font-light tracking-[-0.03em]">
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-[14px] text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Keep it
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? 'Removing…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
