/**
 * AddInvoiceDialog
 *
 * Drop in PDFs or photos of invoices. Each one is stored, read by the AI agent and saved as a
 * draft ("To review"); nothing is posted to the ledger until someone finalises it. The agent
 * works out whether an invoice is owed to you or by you from your business details, so the
 * default is to let it; the choice is there for when a document is ambiguous.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, CircleNotch, FilePdf, UploadSimple, WarningCircle, X } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Segmented } from '~/components/ui/segmented';
import { cn } from '~/lib/utils';

type Direction = 'auto' | 'SALE' | 'PURCHASE';
type Status = 'queued' | 'uploading' | 'done' | 'error';

interface Item {
  id: number;
  file: File;
  status: Status;
  message?: string;
  invoiceId?: string;
}

const ACCEPT = 'application/pdf,image/*';
const accepted = (f: File) => f.type === 'application/pdf' || f.type.startsWith('image/');

export function AddInvoiceDialog({
  open,
  onOpenChange,
  initialFiles,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Files dropped on the page behind the dialog. */
  initialFiles: File[];
  /** Called with the ids of the invoices that were created, once a batch has finished. */
  onUploaded: (invoiceIds: string[]) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [direction, setDirection] = useState<Direction>('auto');
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(1);
  const input = useRef<HTMLInputElement>(null);

  const add = useCallback((files: File[]) => {
    setItems(prev => [
      ...prev,
      ...files.map(file =>
        accepted(file)
          ? { id: nextId.current++, file, status: 'queued' as Status }
          : {
              id: nextId.current++,
              file,
              status: 'error' as Status,
              message: 'Only PDFs and images can be added',
            }
      ),
    ]);
  }, []);

  // Open with whatever was dropped on the page; start clean each time it closes.
  useEffect(() => {
    if (open) {
      if (initialFiles.length > 0) add(initialFiles);
    } else {
      setItems([]);
      setDirection('auto');
      setRunning(false);
    }
  }, [open, initialFiles, add]);

  const patch = (id: number, change: Partial<Item>) =>
    setItems(prev => prev.map(i => (i.id === id ? { ...i, ...change } : i)));

  const upload = async () => {
    const queue = items.filter(
      i =>
        i.status === 'queued' ||
        (i.status === 'error' && i.invoiceId === undefined && accepted(i.file))
    );
    if (queue.length === 0) return;
    setRunning(true);
    const created: string[] = [];
    let failed = false;
    for (const item of queue) {
      patch(item.id, { status: 'uploading', message: undefined });
      try {
        const form = new FormData();
        form.set('intent', 'upload');
        form.set('file', item.file);
        if (direction !== 'auto') form.set('direction', direction);
        const response = await fetch('/api/invoices', { method: 'POST', body: form });
        const result = (await response.json()) as {
          ok: boolean;
          error?: string;
          invoiceId?: string;
          invoiceNumber?: string | null;
          counterparty?: string | null;
        };
        if (!result.ok || !result.invoiceId) throw new Error(result.error ?? 'Upload failed');
        created.push(result.invoiceId);
        patch(item.id, {
          status: 'done',
          invoiceId: result.invoiceId,
          message: [result.counterparty, result.invoiceNumber].filter(Boolean).join(' · '),
        });
      } catch (error) {
        failed = true;
        patch(item.id, {
          status: 'error',
          message: error instanceof Error ? error.message : 'Upload failed',
        });
      }
    }
    setRunning(false);
    if (created.length > 0) onUploaded(created);
    // Everything went through: get out of the way. Otherwise stay, so the failures can be read.
    if (!failed) onOpenChange(false);
  };

  const waiting = items.filter(i => i.status === 'queued').length;
  const retryable = items.filter(i => i.status === 'error' && accepted(i.file)).length;
  const finished = items.length > 0 && items.every(i => i.status === 'done');

  return (
    <Dialog open={open} onOpenChange={next => !running && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-[28px] font-light tracking-[-0.03em]">
            Add invoices
          </DialogTitle>
          <DialogDescription>
            Each one is read and saved as a draft for you to review. Nothing reaches your books
            until you finalise it.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={e => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setDragging(false);
            add(Array.from(e.dataTransfer.files));
          }}
          className={cn(
            'rounded-2xl border border-dashed border-border-strong bg-card p-6 text-center transition-colors',
            dragging && 'border-ring bg-accent'
          )}
        >
          <UploadSimple size={28} weight="light" aria-hidden className="mx-auto text-text-2" />
          <p className="mt-2 text-[15px]">Drop PDFs or photos here</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={running}
            onClick={() => input.current?.click()}
          >
            Choose files
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            aria-label="Choose invoice files"
            className="sr-only"
            onChange={e => {
              add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <p className="mt-2 text-[13px] text-muted-foreground">Up to 10 MB each.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Direction</span>
          <Segmented<Direction>
            label="Direction"
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'auto', label: 'Work it out' },
              { value: 'SALE', label: 'Owed to you' },
              { value: 'PURCHASE', label: 'You owe' },
            ]}
          />
        </div>

        {items.length > 0 && (
          <ul aria-label="Files" className="divide-y rounded-xl border">
            {items.map(item => (
              <li key={item.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[14px]">
                {item.status === 'uploading' ? (
                  <CircleNotch size={18} className="shrink-0 animate-spin" aria-hidden />
                ) : item.status === 'done' ? (
                  <CheckCircle
                    size={18}
                    weight="fill"
                    className="shrink-0 text-income"
                    aria-hidden
                  />
                ) : item.status === 'error' ? (
                  <WarningCircle
                    size={18}
                    weight="fill"
                    className="shrink-0 text-destructive"
                    aria-hidden
                  />
                ) : (
                  <FilePdf size={18} weight="light" className="shrink-0 text-text-2" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.file.name}</span>
                  <span
                    className={cn(
                      'block truncate text-[13px]',
                      item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {item.status === 'uploading'
                      ? 'Reading the invoice…'
                      : item.status === 'queued'
                        ? 'Ready'
                        : item.message}
                  </span>
                </span>
                {item.status !== 'uploading' && item.status !== 'done' && !running && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => setItems(prev => prev.filter(i => i.id !== item.id))}
                    className="rounded-full p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2.5">
          <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>
            {finished ? 'Done' : 'Cancel'}
          </Button>
          {!finished && (
            <Button onClick={upload} disabled={running || waiting + retryable === 0}>
              {running
                ? 'Adding…'
                : waiting === 0 && retryable > 0
                  ? 'Try again'
                  : `Add ${waiting || ''} ${waiting === 1 ? 'invoice' : 'invoices'}`.replace(
                      '  ',
                      ' '
                    )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
