/**
 * The user's conversations: open one, rename it, delete it (after a confirmation that says
 * what goes). Shown in the panel's history view and beside the thread on `/chat`.
 */

import { useState } from 'react';
import type { Thread } from '@langchain/langgraph-sdk';
import { PencilSimple, Plus, Trash } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { cn } from '~/lib/utils';
import { useAssistant } from '~/providers/AssistantProvider';
import { PRIVACY_NOTE } from '~/lib/assistant-privacy';
import { formatDate } from './format';

export function threadTitle(thread: Thread | undefined): string {
  const title = (thread?.metadata as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.trim() ? title : 'New conversation';
}

export function ThreadList({ onOpen }: { onOpen?: () => void }) {
  const assistant = useAssistant();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);

  const startNew = () => {
    assistant.newThread();
    onOpen?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2">
        <h3 className="eyebrow">Conversations</h3>
        <Button size="sm" variant="outline" onClick={startNew}>
          <Plus size={14} aria-hidden /> New
        </Button>
      </div>
      {assistant.threadsError && (
        <p role="alert" className="text-sm text-destructive">
          Your conversations could not be loaded.{' '}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => void assistant.refreshThreads()}
          >
            Try again
          </button>
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {failed}
        </p>
      )}
      {!assistant.threadsError && assistant.threads.length === 0 && (
        <p className="py-6 text-sm text-text-2">
          No conversations yet. Ask a question to start one.
        </p>
      )}
      <ul aria-label="Conversations" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {assistant.threads.map(thread => {
          const id = thread.thread_id;
          const current = id === assistant.threadId;
          const title = threadTitle(thread);
          if (renaming === id) {
            return (
              <li key={id}>
                <form
                  className="flex items-center gap-1.5 rounded-xl border bg-card p-1.5"
                  onSubmit={async e => {
                    e.preventDefault();
                    setRenaming(null);
                    if (!draft.trim() || draft.trim() === title) return;
                    try {
                      await assistant.renameThread(id, draft);
                      setFailed(null);
                    } catch {
                      setFailed('That conversation could not be renamed.');
                    }
                  }}
                >
                  <label htmlFor={`rename-${id}`} className="sr-only">
                    New name for {title}
                  </label>
                  <input
                    id={`rename-${id}`}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Escape' && setRenaming(null)}
                    maxLength={80}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm focus-visible:outline-none"
                  />
                  <Button type="submit" size="sm">
                    Save
                  </Button>
                </form>
              </li>
            );
          }
          return (
            <li key={id} className="group flex items-center gap-1">
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  assistant.selectThread(id);
                  onOpen?.();
                }}
                className={cn(
                  'min-w-0 flex-1 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  current && 'bg-accent'
                )}
              >
                <span className="block truncate text-sm">{title}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatDate(thread.updated_at)}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Rename ${title}`}
                onClick={() => {
                  setDraft(title);
                  setRenaming(id);
                }}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PencilSimple size={14} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Delete ${title}`}
                onClick={() => setDeleting(thread)}
                className="rounded-md p-1.5 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 space-y-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">{PRIVACY_NOTE}</p>
        {assistant.threads.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setDeletingAll(true)}>
            <Trash size={14} aria-hidden /> Delete all conversations
          </Button>
        )}
      </div>

      <Dialog open={deletingAll} onOpenChange={setDeletingAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all your conversations?</DialogTitle>
            <DialogDescription>
              Every conversation with the assistant will be deleted. This cannot be undone. Your
              business data is not affected, and what the assistant remembers is kept (delete it
              under Memory).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingAll(false)}>
              Keep them
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setDeletingAll(false);
                try {
                  await assistant.deleteAllThreads();
                  setFailed(null);
                } catch {
                  setFailed('Your conversations could not all be deleted. Try again.');
                }
              }}
            >
              Delete everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting != null} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>
              “{threadTitle(deleting ?? undefined)}” and everything in it will be deleted. This
              cannot be undone. Your business data is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const thread = deleting;
                setDeleting(null);
                if (!thread) return;
                try {
                  await assistant.deleteThread(thread.thread_id);
                  setFailed(null);
                } catch {
                  setFailed('That conversation could not be deleted.');
                }
              }}
            >
              Delete conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
