/**
 * The assistant as a right-hand panel on every authenticated page.
 *
 * Layout is CSS, so the server renders it right: where the page can keep its designed width
 * (`DOCK_MIN_VIEWPORT`, 1700px) it docks and the page makes room for it (`AppLayout` reserves
 * `--assistant-dock`); narrower, it overlays the page with a scrim; on a phone it is a
 * full-height sheet. Only behaviour depends on the width:
 * when it overlays, focus stays inside it and Escape closes it.
 *
 * Opening moves focus to the composer; closing returns it to whatever opened the panel (the
 * launcher). Width is resizable by dragging or with the arrow keys, and remembered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { ArrowsOutSimple, Brain, ClockCounterClockwise, Plus, X } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { DOCK_MIN_VIEWPORT, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '~/lib/assistant-panel';
import { useAssistant } from '~/providers/AssistantProvider';
import { Conversation } from './Conversation';
import { MemoryList } from './MemoryList';
import { ThreadList, threadTitle } from './ThreadList';

const DOCK_QUERY = `(min-width: ${DOCK_MIN_VIEWPORT}px)`;

function useDocked(): boolean {
  const [docked, setDocked] = useState(true);
  useEffect(() => {
    const media = window.matchMedia(DOCK_QUERY);
    const update = () => setDocked(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return docked;
}

const headerButton =
  'inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground';

export function AssistantPanel() {
  const assistant = useAssistant();
  const { open, setOpen, composerRef } = assistant;
  const docked = useDocked();
  const modal = !docked;
  const [view, setView] = useState<'conversation' | 'history' | 'memory'>('conversation');
  const opener = useRef<Element | null>(null);

  // Remember what opened the panel; move focus to the composer. Give it back on close.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      const from = opener.current;
      // Back to what opened it; else the launcher the user can see (the phone header's, or
      // the sidebar's: `offsetParent` is null for the one hidden at this width).
      const shown = ['assistant-launcher-header', 'assistant-launcher']
        .map(id => document.getElementById(id))
        .find(el => el?.offsetParent != null);
      const back =
        from instanceof HTMLElement && from.isConnected && from !== document.body ? from : shown;
      back?.focus();
    };
  }, [open, composerRef]);

  useEffect(() => {
    if (!open || !modal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, modal, setOpen]);

  if (!open) return null;

  const current = assistant.threads.find(t => t.thread_id === assistant.threadId);
  const expandTo = assistant.threadId ? `/chat?thread=${assistant.threadId}` : '/chat';

  return (
    <>
      {modal && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/30 min-[1700px]:hidden"
        />
      )}
      <FocusScope asChild trapped={modal} loop={modal}>
        <div
          id="assistant-panel"
          role={modal ? 'dialog' : 'complementary'}
          aria-modal={modal ? true : undefined}
          aria-label="Assistant"
          className={cn(
            'fixed inset-0 z-50 flex flex-col bg-background shadow-2xl',
            'md:inset-y-0 md:left-auto md:right-0 md:w-[min(var(--assistant-w),90vw)] md:border-l',
            'min-[1700px]:z-30 min-[1700px]:w-[var(--assistant-dock)] min-[1700px]:shadow-none'
          )}
        >
          <ResizeHandle />
          <header className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
            <div className="min-w-0 flex-1 px-1">
              <h2 className="truncate text-sm font-medium">
                {view === 'history'
                  ? 'Conversations'
                  : view === 'memory'
                    ? 'Memory'
                    : threadTitle(current)}
              </h2>
            </div>
            <button
              type="button"
              className={headerButton}
              aria-label="Conversations"
              aria-pressed={view === 'history'}
              onClick={() => setView(v => (v === 'history' ? 'conversation' : 'history'))}
            >
              <ClockCounterClockwise size={18} aria-hidden />
            </button>
            <button
              type="button"
              className={headerButton}
              aria-label="Memory"
              aria-pressed={view === 'memory'}
              onClick={() => setView(v => (v === 'memory' ? 'conversation' : 'memory'))}
            >
              <Brain size={18} aria-hidden />
            </button>
            <button
              type="button"
              className={headerButton}
              aria-label="New conversation"
              onClick={() => {
                assistant.newThread();
                setView('conversation');
                requestAnimationFrame(() => composerRef.current?.focus());
              }}
            >
              <Plus size={18} aria-hidden />
            </button>
            <Link
              to={expandTo}
              className={cn(headerButton, 'hidden md:inline-flex')}
              aria-label="Open full width"
              onClick={() => setOpen(false)}
            >
              <ArrowsOutSimple size={18} aria-hidden />
            </Link>
            <button
              type="button"
              className={headerButton}
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
            >
              <X size={18} aria-hidden />
            </button>
          </header>
          {view === 'history' ? (
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <ThreadList onOpen={() => setView('conversation')} />
            </div>
          ) : view === 'memory' ? (
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <MemoryList />
            </div>
          ) : (
            <Conversation />
          )}
        </div>
      </FocusScope>
    </>
  );
}

/** Drag the left edge, or focus it and use the arrow keys (Home/End for the limits). */
function ResizeHandle() {
  const { width, setWidth } = useAssistant();
  const dragging = useRef(false);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (dragging.current) setWidth(window.innerWidth - event.clientX);
    },
    [setWidth]
  );
  const stop = useCallback(() => {
    dragging.current = false;
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stop);
  }, [onPointerMove]);
  useEffect(() => stop, [stop]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize assistant"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={event => {
        event.preventDefault();
        dragging.current = true;
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stop);
      }}
      onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16;
        const next =
          event.key === 'ArrowLeft'
            ? width + step
            : event.key === 'ArrowRight'
              ? width - step
              : event.key === 'Home'
                ? PANEL_MIN_WIDTH
                : event.key === 'End'
                  ? PANEL_MAX_WIDTH
                  : null;
        if (next == null) return;
        event.preventDefault();
        setWidth(next);
      }}
      className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block [&:hover]:bg-border-strong/40"
    />
  );
}
