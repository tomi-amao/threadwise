/**
 * The assistant: one conversation, available on every authenticated page.
 *
 * Mounted once in `AppLayout`, so a conversation survives navigation. `useStream` (LangGraph
 * SDK) is the single source of truth for messages, UI messages and interrupts; this provider
 * adds what the panel needs around it: which thread is open (remembered per user, and
 * `/chat?thread=` for a link), the thread list, the panel's open state and width (a cookie,
 * see `lib/assistant-panel.ts`), ⌘/Ctrl+J, and the actions (send, answer a clarifying
 * question, stop, regenerate, edit and resend, feedback).
 *
 * Every request carries the user's Supabase token: the LangGraph server refuses anything
 * else and scopes threads to their owner.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Client, type Message, type Thread } from '@langchain/langgraph-sdk';
import { useStream } from '@langchain/langgraph-sdk/react';
import {
  isRemoveUIMessage,
  isUIMessage,
  uiMessageReducer,
  type RemoveUIMessage,
  type UIMessage,
} from '@langchain/langgraph-sdk/react-ui';
import { v4 as uuidv4 } from 'uuid';
import { getSupabaseBrowserClient } from '~/lib/supabase-browser';
import { clampWidth, writePanelCookie, type PanelState } from '~/lib/assistant-panel';
import { parseClarify, type Clarify } from '~/components/assistant/catalogue';
import { useAuth } from './AuthProvider';

const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';
const ASSISTANT_ID = import.meta.env.VITE_LANGGRAPH_ASSISTANT_ID || 'threadwise-financial-agent';
// Checkpoints fetched when a thread loads: enough to find where the last few questions started
// (edit and resend shows only where it can fork; regenerate needs only the latest turn). Each
// checkpoint carries the whole state, so more costs more than it is worth on a long thread.
const HISTORY_LIMIT = 30;
const STREAM_MODES: ('values' | 'messages-tuple' | 'custom')[] = [
  'values',
  'messages-tuple',
  'custom',
];

type Feedback = 'up' | 'down';

export interface AssistantValues extends Record<string, unknown> {
  messages: Message[];
  ui?: UIMessage[];
}

type Bag = {
  UpdateType: { messages?: Message[] | Message };
  CustomEventType: UIMessage | RemoveUIMessage | { progress?: string };
};

let client: Client | null = null;

/**
 * `fetch`, except that a request the user stopped fails as the SDK expects. Its retrying
 * caller (@langchain/langgraph-sdk 1.11.0) recognises an abort only by an error message
 * starting "AbortError"; the browser's says "signal is aborted without reason", so a run
 * stopped before the server answered was retried with backoff and Stop took ~20s to take
 * effect. The error stays an AbortError, which the SDK then ignores quietly.
 */
async function stoppableFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DOMException(`AbortError: ${error.message}`, 'AbortError');
    }
    throw error;
  }
}

/** The LangGraph client, created once; every request is signed with the user's token. */
function getClient(): Client {
  if (!client) {
    client = new Client({
      apiUrl: API_URL,
      callerOptions: { fetch: stoppableFetch },
      onRequest: async (_url, init) => {
        const { data } = await getSupabaseBrowserClient().auth.getSession();
        const headers = new Headers(init.headers);
        if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`);
        return { ...init, headers };
      },
    });
  }
  return client;
}

function titleFrom(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  if (flat.length <= 60) return flat;
  const cut = flat.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

function threadKey(userId: string) {
  return `tw-assistant-thread:${userId}`;
}

function readStoredThread(userId: string | undefined): string | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(threadKey(userId));
  } catch {
    return null;
  }
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

interface AssistantContextValue {
  // panel
  open: boolean;
  width: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
  onChatPage: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  // threads
  threadId: string | null;
  threads: Thread[];
  threadsError: boolean;
  refreshThreads: () => Promise<void>;
  newThread: () => void;
  selectThread: (id: string) => void;
  renameThread: (id: string, title: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  // conversation
  messages: Message[];
  ui: UIMessage[];
  isLoading: boolean;
  isThreadLoading: boolean;
  error: unknown;
  progress: string | null;
  clarify: Clarify | null;
  send: (text: string) => void;
  answer: (text: string) => void;
  stop: () => void;
  retry: () => void;
  /** There is a last request to send again. */
  canRetry: boolean;
  canRegenerate: (message: Message) => boolean;
  regenerate: (message: Message) => void;
  canEdit: (message: Message) => boolean;
  edit: (message: Message, text: string) => void;
  feedback: Record<string, Feedback>;
  setFeedback: (messageId: string, value: Feedback | null) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({
  initialPanel,
  children,
}: {
  initialPanel: PanelState;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const userId = user?.id;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const onChatPage = location.pathname === '/chat';
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ── panel ────────────────────────────────────────────────────────────────────────
  const [panel, setPanel] = useState<PanelState>(initialPanel);
  const firstPanel = useRef(true);
  useEffect(() => {
    if (firstPanel.current) {
      firstPanel.current = false; // already what the cookie says
      return;
    }
    writePanelCookie(panel);
  }, [panel]);
  const setOpen = useCallback((open: boolean) => setPanel(prev => ({ ...prev, open })), []);
  const toggle = useCallback(() => setPanel(prev => ({ ...prev, open: !prev.open })), []);
  const setWidth = useCallback(
    (width: number) => setPanel(prev => ({ ...prev, width: clampWidth(width) })),
    []
  );

  // ⌘/Ctrl+J: toggle the panel (on /chat, where the thread is the page, go to the composer).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return;
      event.preventDefault();
      if (onChatPage) composerRef.current?.focus();
      else toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChatPage, toggle]);

  // ── which thread ─────────────────────────────────────────────────────────────────
  const [threadId, setThreadIdState] = useState<string | null>(null);
  const setThreadId = useCallback(
    (id: string | null) => {
      setThreadIdState(id);
      if (!userId) return;
      try {
        if (id) window.localStorage.setItem(threadKey(userId), id);
        else window.localStorage.removeItem(threadKey(userId));
      } catch {
        // Private mode: the thread is just not remembered.
      }
    },
    [userId]
  );
  // The remembered thread, once we know who is signed in (client only).
  useEffect(() => {
    setThreadIdState(readStoredThread(userId));
  }, [userId]);
  // `/chat?thread=<id>` opens that thread (a link someone kept or shared with themselves).
  const threadFromUrl = onChatPage ? searchParams.get('thread') : null;
  useEffect(() => {
    if (threadFromUrl) setThreadId(threadFromUrl);
  }, [threadFromUrl, setThreadId]);

  // ── threads ──────────────────────────────────────────────────────────────────────
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsError, setThreadsError] = useState(false);
  const refreshThreads = useCallback(async () => {
    if (!userId) return;
    try {
      const found = await getClient().threads.search({
        limit: 50,
        sortBy: 'updated_at',
        sortOrder: 'desc',
      });
      setThreads(found);
      setThreadsError(false);
    } catch {
      setThreadsError(true);
    }
  }, [userId]);
  useEffect(() => {
    if (panel.open || onChatPage) void refreshThreads();
  }, [panel.open, onChatPage, refreshThreads]);

  // ── the stream ───────────────────────────────────────────────────────────────────
  const [progress, setProgress] = useState<string | null>(null);
  const lastSubmit = useRef<(() => void) | null>(null);

  const stream = useStream<AssistantValues, Bag>({
    client: getClient(),
    assistantId: ASSISTANT_ID,
    threadId,
    fetchStateHistory: { limit: HISTORY_LIMIT },
    onThreadId: id => {
      setThreadId(id);
      if (onChatPage) navigate(`/chat?thread=${id}`, { replace: true });
    },
    onCustomEvent: (event, options) => {
      if (isUIMessage(event) || isRemoveUIMessage(event)) {
        options.mutate(prev => ({ ...prev, ui: uiMessageReducer(prev.ui ?? [], event) }));
      } else if (event && typeof (event as { progress?: unknown }).progress === 'string') {
        setProgress((event as { progress: string }).progress);
      }
    },
    onFinish: () => {
      setProgress(null);
      void refreshThreads();
    },
    onError: error => {
      setProgress(null);
      // A thread that no longer exists (deleted, expired, someone else's): start afresh.
      if (errorStatus(error) === 404 && threadId) setThreadId(null);
    },
  });

  useEffect(() => {
    if (!stream.isLoading) setProgress(null);
  }, [stream.isLoading]);
  const isLoading = stream.isLoading;

  const clarify = useMemo(
    () => (stream.interrupt ? parseClarify(stream.interrupt.value) : null),
    [stream.interrupt]
  );

  const submit = useCallback((run: () => Promise<void>) => {
    lastSubmit.current = () => void run();
    void run();
  }, []);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || isLoading) return;
      const message: Message = { id: uuidv4(), type: 'human', content };
      submit(() =>
        stream.submit(
          { messages: [message] },
          {
            streamMode: STREAM_MODES,
            optimisticValues: prev => ({
              ...prev,
              messages: [...(prev.messages ?? []), message],
            }),
            // Names a new thread after its first question.
            metadata: threadId ? undefined : { title: titleFrom(content) },
          }
        )
      );
    },
    [isLoading, stream, submit, threadId]
  );

  const answer = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || isLoading) return;
      submit(() =>
        stream.submit(null, { command: { resume: { answer: content } }, streamMode: STREAM_MODES })
      );
    },
    [isLoading, stream, submit]
  );

  const parentCheckpoint = useCallback(
    (message: Message) => stream.getMessagesMetadata(message)?.firstSeenState?.parent_checkpoint,
    [stream]
  );

  const canRegenerate = useCallback(
    (message: Message) => message.type === 'ai' && !isLoading && !!parentCheckpoint(message),
    [parentCheckpoint, isLoading]
  );
  const regenerate = useCallback(
    (message: Message) => {
      const checkpoint = parentCheckpoint(message);
      if (!checkpoint) return;
      submit(() => stream.submit(undefined, { checkpoint, streamMode: STREAM_MODES }));
    },
    [parentCheckpoint, stream, submit]
  );

  const canEdit = useCallback(
    (message: Message) => message.type === 'human' && !isLoading && !!parentCheckpoint(message),
    [parentCheckpoint, isLoading]
  );
  const edit = useCallback(
    (message: Message, text: string) => {
      const checkpoint = parentCheckpoint(message);
      const content = text.trim();
      if (!checkpoint || !content) return;
      const replacement: Message = { id: uuidv4(), type: 'human', content };
      const before = stream.messages.slice(
        0,
        stream.messages.findIndex(m => m.id === message.id)
      );
      submit(() =>
        stream.submit(
          { messages: [replacement] },
          {
            checkpoint,
            streamMode: STREAM_MODES,
            optimisticValues: prev => ({ ...prev, messages: [...before, replacement] }),
          }
        )
      );
    },
    [parentCheckpoint, stream, submit]
  );

  const retry = useCallback(() => lastSubmit.current?.(), []);
  const stop = useCallback(() => void stream.stop(), [stream]);

  // ── thread actions ───────────────────────────────────────────────────────────────
  const newThread = useCallback(() => setThreadId(null), [setThreadId]);
  const selectThread = useCallback((id: string) => setThreadId(id), [setThreadId]);
  const renameThread = useCallback(
    async (id: string, title: string) => {
      await getClient().threads.update(id, { metadata: { title: title.trim() } });
      await refreshThreads();
    },
    [refreshThreads]
  );
  const deleteThread = useCallback(
    async (id: string) => {
      await getClient().threads.delete(id);
      if (id === threadId) setThreadId(null);
      await refreshThreads();
    },
    [refreshThreads, setThreadId, threadId]
  );

  // ── feedback (stored on the thread, for evals) ───────────────────────────────────
  const current = threads.find(t => t.thread_id === threadId);
  const [feedback, setFeedbackState] = useState<Record<string, Feedback>>({});
  useEffect(() => {
    const stored = (current?.metadata as { feedback?: Record<string, Feedback> } | undefined)
      ?.feedback;
    setFeedbackState(stored ?? {});
  }, [current]);
  const setFeedback = useCallback(
    (messageId: string, value: Feedback | null) => {
      if (!threadId) return;
      const next = { ...feedback };
      if (value) next[messageId] = value;
      else delete next[messageId];
      setFeedbackState(next);
      // Best effort: a lost thumbs-up is not worth an error in the conversation.
      void getClient()
        .threads.update(threadId, { metadata: { feedback: next } })
        .catch(() => undefined);
    },
    [feedback, threadId]
  );

  const value: AssistantContextValue = {
    open: panel.open,
    width: panel.width,
    setOpen,
    toggle,
    setWidth,
    onChatPage,
    composerRef,
    threadId,
    threads,
    threadsError,
    refreshThreads,
    newThread,
    selectThread,
    renameThread,
    deleteThread,
    messages: stream.messages,
    ui: stream.values?.ui ?? [],
    isLoading,
    isThreadLoading: stream.isThreadLoading,
    error: stream.error,
    progress,
    clarify,
    send,
    answer,
    stop,
    retry,
    canRetry: lastSubmit.current != null,
    canRegenerate,
    regenerate,
    canEdit,
    edit,
    feedback,
    setFeedback,
  };

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const context = useContext(AssistantContext);
  if (!context) throw new Error('useAssistant must be used within an AssistantProvider');
  return context;
}
