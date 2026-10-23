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
import {
  parseClarify,
  parseProposal,
  type Clarify,
  type Proposal,
} from '~/components/assistant/catalogue';
import {
  contextFromUrl,
  toRunContext,
  type PageContext,
  type PageRecord,
} from '~/lib/assistant-context';
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

export interface Memory {
  id: string;
  fact: string;
}

const MEMORY_LABEL = 'memories';

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
      // One retry, not the SDK's four: a refusal (HTTP 429, a busy model) should show in a
      // second or two, not after fifteen seconds of backoff. Try again is a click away.
      callerOptions: { fetch: stoppableFetch, maxRetries: 1 },
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
  /** Delete every conversation this user has. Returns how many. */
  deleteAllThreads: () => Promise<number>;
  // conversation
  messages: Message[];
  ui: UIMessage[];
  isLoading: boolean;
  isThreadLoading: boolean;
  error: unknown;
  progress: string | null;
  clarify: Clarify | null;
  /** A change the agent proposed; nothing happens until the user decides. */
  proposal: Proposal | null;
  send: (text: string) => void;
  answer: (text: string) => void;
  decide: (decision: 'approve' | 'dismiss') => void;
  // what the user is looking at
  /** The page (and open record) the next question is sent with; null if it is turned off. */
  pageContext: PageContext | null;
  /** Take the page out of the next questions (until the user goes to another page). */
  dismissPageContext: () => void;
  setPageRecord: (record: PageRecord | null) => void;
  /** A record is open on the page (a drawer), so the drawer can offer "Ask about this". */
  canAskAbout: boolean;
  /** Keep the open record as the chip's context and open the panel. */
  askAbout: () => void;
  // memory
  memories: Memory[];
  memoriesError: boolean;
  refreshMemories: () => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
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
  const { user, entity } = useAuth();
  const userId = user?.id;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const onChatPage = location.pathname === '/chat';
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ── what the user is looking at ─────────────────────────────────────────────────────
  // The page and its filters come from the URL; the record in a drawer is registered by the
  // page (`useAssistantRecord`). Taking the chip off turns it off until the next page.
  const [liveRecord, setLiveRecord] = useState<PageRecord | null>(null);
  // The record kept when the user pressed "Ask about this" in its drawer (which closes the
  // drawer so the panel can open). It lasts until they leave the page, open another record
  // or turn the chip off, so the chip always says what a question will be about.
  const [heldRecord, setHeldRecord] = useState<PageRecord | null>(null);
  const [contextOffFor, setContextOffFor] = useState<string | null>(null);
  const record = liveRecord ?? heldRecord;
  const setPageRecord = useCallback((next: PageRecord | null) => {
    setLiveRecord(next);
    if (next) setHeldRecord(null);
  }, []);
  useEffect(() => {
    setHeldRecord(null);
  }, [location.pathname]);
  const urlContext = useMemo(
    () => contextFromUrl(location.pathname, searchParams),
    [location.pathname, searchParams]
  );
  const pageContext = useMemo<PageContext | null>(() => {
    if (!urlContext || contextOffFor === location.pathname) return null;
    return { ...urlContext, record };
  }, [urlContext, record, contextOffFor, location.pathname]);
  const dismissPageContext = useCallback(() => {
    setContextOffFor(location.pathname);
    setHeldRecord(null);
  }, [location.pathname]);
  // A record belongs to the page that registered it: `useAssistantRecord` clears it when the
  // page goes away (an effect here would run after the new page's and wipe its record).

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

  const askAbout = useCallback(() => {
    setHeldRecord(liveRecord);
    setPanel(prev => ({ ...prev, open: true }));
  }, [liveRecord]);

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
  // A proposal the browser cannot show is never approved blind: it is treated as no proposal,
  // and the run stays paused (nothing happens).
  const proposal = useMemo(
    () => (stream.interrupt ? parseProposal(stream.interrupt.value) : null),
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
            // What the user is looking at. The agent only believes what it can re-read.
            context: pageContext ? toRunContext(pageContext) : undefined,
          }
        )
      );
    },
    [isLoading, pageContext, stream, submit, threadId]
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

  const decide = useCallback(
    (decision: 'approve' | 'dismiss') => {
      if (isLoading) return;
      submit(() =>
        stream.submit(null, { command: { resume: { decision } }, streamMode: STREAM_MODES })
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

  const deleteAllThreads = useCallback(async () => {
    const ids: string[] = [];
    // Every page, not just the 50 the list shows.
    for (let offset = 0; ; offset += 100) {
      const page = await getClient().threads.search({ limit: 100, offset });
      ids.push(...page.map(t => t.thread_id));
      if (page.length < 100) break;
    }
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(id => getClient().threads.delete(id)));
    }
    setThreadId(null);
    await refreshThreads();
    return ids.length;
  }, [refreshThreads, setThreadId]);

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
      // And one row per rating for the review queue: ids only, never the question or the
      // answer (supabase/migrations/20261022000000_assistant_feedback.sql).
      if (entity?.id && userId) {
        const table = getSupabaseBrowserClient().from('assistant_feedback');
        const saved = value
          ? table.upsert(
              {
                entity_id: entity.id,
                user_id: userId,
                thread_id: threadId,
                message_id: messageId,
                rating: value,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id,thread_id,message_id' }
            )
          : table.delete().eq('thread_id', threadId).eq('message_id', messageId);
        void Promise.resolve(saved).catch(() => undefined);
      }
    },
    [entity?.id, feedback, threadId, userId]
  );

  // ── memory (what the assistant was asked to remember; the user can see and delete it) ──
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesError, setMemoriesError] = useState(false);
  const refreshMemories = useCallback(async () => {
    if (!userId) return;
    try {
      const { items } = await getClient().store.searchItems([userId, MEMORY_LABEL], {
        limit: 50,
      });
      setMemories(
        items
          .map(item => ({
            id: item.key,
            fact: String((item.value as { fact?: unknown }).fact ?? ''),
            saved: String((item.value as { saved_at?: unknown }).saved_at ?? ''),
          }))
          .filter(m => m.fact)
          .sort((a, b) => a.saved.localeCompare(b.saved))
          .map(({ id, fact }) => ({ id, fact }))
      );
      setMemoriesError(false);
    } catch {
      setMemoriesError(true);
    }
  }, [userId]);
  const deleteMemory = useCallback(
    async (id: string) => {
      if (!userId) return;
      await getClient().store.deleteItem([userId, MEMORY_LABEL], id);
      await refreshMemories();
    },
    [refreshMemories, userId]
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
    deleteAllThreads,
    messages: stream.messages,
    ui: stream.values?.ui ?? [],
    isLoading,
    isThreadLoading: stream.isThreadLoading,
    error: stream.error,
    progress,
    clarify,
    proposal,
    send,
    answer,
    decide,
    pageContext,
    dismissPageContext,
    setPageRecord,
    canAskAbout: liveRecord != null && !onChatPage,
    askAbout,
    memories,
    memoriesError,
    refreshMemories,
    deleteMemory,
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

/**
 * Tell the assistant which record is open on this page (an invoice's drawer, say), so a
 * question like "why is this unmatched?" is about it. Pass null while nothing is open.
 */
export function useAssistantRecord(record: PageRecord | null) {
  const setPageRecord = useOptionalAssistant()?.setPageRecord;
  const type = record?.type;
  const id = record?.id;
  const label = record?.label ?? null;
  useEffect(() => {
    if (!setPageRecord) return;
    setPageRecord(type && id ? { type, id, label } : null);
    return () => setPageRecord(null);
  }, [setPageRecord, type, id, label]);
}

/** The assistant, or null where there is none (so shared components can offer it if present). */
export function useOptionalAssistant(): AssistantContextValue | null {
  return useContext(AssistantContext);
}

export function useAssistant(): AssistantContextValue {
  const context = useContext(AssistantContext);
  if (!context) throw new Error('useAssistant must be used within an AssistantProvider');
  return context;
}
