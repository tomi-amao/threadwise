import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { useStream } from '@langchain/langgraph-sdk/react';
import { Client, Thread, Message } from '@langchain/langgraph-sdk';
import {
  uiMessageReducer,
  isUIMessage,
  isRemoveUIMessage,
  type UIMessage,
  type RemoveUIMessage,
} from '@langchain/langgraph-sdk/react-ui';
import { useNavigate, useSearchParams } from 'react-router';
import { v4 as uuidv4 } from 'uuid';
import type { Base64ContentBlock } from '~/lib/multimodal-utils';

/**
 * ThreadWise Chat Provider - Client-side only architecture
 *
 * Uses LangGraph SDK types directly - no conversion overhead
 * Single source of truth: useStream hook
 * Configuration is handled entirely through environment variables
 *
 * Generative UI Support:
 * - UI messages are streamed via onCustomEvent handler
 * - Uses uiMessageReducer from @langchain/langgraph-sdk/react-ui
 */

export type ModelType = 'local' | 'gemini';
export type DataSourceType = 'sql_toolkit' | 'supabase_mcp';

export interface DataSource {
  id: DataSourceType;
  name: string;
  description: string;
  type: 'builtin' | 'mcp';
  status: 'available' | 'unavailable' | 'unconfigured';
}

// Type for stream state including UI messages
export type StreamStateType = {
  messages: Message[];
  ui?: UIMessage[];
};

// Configuration from environment variables - no runtime changes allowed
const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';
const ASSISTANT_ID = import.meta.env.VITE_LANGGRAPH_ASSISTANT_ID || 'threadwise-financial-agent';
const AI_AGENT_API_URL = import.meta.env.VITE_AI_AGENT_API_URL || 'http://localhost:8000';

interface ChatState {
  threads: Thread[];
  currentThread: Thread | null;
  error: string | null;
  selectedModel: ModelType;
  selectedDataSource: DataSourceType;
  availableDataSources: DataSource[];
}

// Type for the useStream hook return value
type StreamType = ReturnType<
  typeof useStream<
    StreamStateType,
    {
      UpdateType: {
        messages?: Message[] | Message | string;
        ui?: (UIMessage | RemoveUIMessage)[] | UIMessage | RemoveUIMessage;
      };
      CustomEventType: UIMessage | RemoveUIMessage;
    }
  >
>;

interface ChatContextType extends ChatState {
  createThread: () => Promise<Thread>;
  selectThread: (threadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (content: string, attachments?: Base64ContentBlock[]) => Promise<void>;
  refreshThreads: () => Promise<void>;
  isStreaming: boolean;
  stopGeneration: () => void;
  messages: Message[];
  setSelectedModel: (model: ModelType) => void;
  setSelectedDataSource: (source: DataSourceType) => void;
  // Expose full stream for UI message rendering with for rendering generative UI
  stream: StreamType;
  // UI messages from generative UI
  uiMessages: UIMessage[];
}

const ChatContext = createContext<ChatContextType | null>(null);

// Module-level client (initialized once with env variables)
let langGraphClient: Client | null = null;

function generateThreadTitle(firstMessage: string): string {
  const cleaned = firstMessage.trim().replace(/\n+/g, ' ');
  const maxLength = 50;

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const truncated = cleaned.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  return lastSpace > 0 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
}

async function updateThreadMetadata(
  client: Client,
  threadId: string,
  metadata: Record<string, any>
): Promise<void> {
  try {
    await client.threads.update(threadId, { metadata });
  } catch (error) {
    console.error('Failed to update thread metadata:', error);
    throw error;
  }
}

interface ChatProviderProps {
  children: React.ReactNode;
}

export function ChatProvider({ children }: ChatProviderProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const threadIdFromUrl = searchParams.get('thread');

  // Initialize LangGraph client once
  useEffect(() => {
    if (!langGraphClient) {
      langGraphClient = new Client({
        apiUrl: API_URL,
      });
    }
  }, []);

  // Threads state
  const [threads, setThreads] = useState<Thread[]>([]);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<ModelType>('local');

  // Data source selection state
  const [selectedDataSource, setSelectedDataSource] = useState<DataSourceType>('sql_toolkit');
  const [availableDataSources, setAvailableDataSources] = useState<DataSource[]>([
    {
      id: 'sql_toolkit',
      name: 'Direct SQL',
      description: 'Connect directly to the database via SQLDatabaseToolkit',
      type: 'builtin',
      status: 'available',
    },
  ]);

  // Fetch available data sources from AI Agent API
  useEffect(() => {
    async function fetchDataSources() {
      try {
        const response = await fetch(`${AI_AGENT_API_URL}/chat/data-sources`);
        if (response.ok) {
          const data = await response.json();
          if (data.data_sources && data.data_sources.length > 0) {
            setAvailableDataSources(data.data_sources);
          }
        }
      } catch (error) {
        console.warn('Failed to fetch data sources, using defaults:', error);
      }
    }
    fetchDataSources();
  }, []);

  // Fetch threads from LangGraph
  const fetchThreads = useCallback(async () => {
    if (!langGraphClient) return [];

    try {
      const threadsResponse = await langGraphClient.threads.search({ limit: 100 });
      setThreads(threadsResponse);
      return threadsResponse;
    } catch (error) {
      console.error('Failed to fetch threads:', error);
      return [];
    }
  }, []);

  // Load threads on mount
  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  // useStream hook - single source of truth for messages and UI
  // Handles generative UI via onCustomEvent with uiMessageReducer
  const stream = useStream<
    StreamStateType,
    {
      UpdateType: {
        messages?: Message[] | Message | string;
        ui?: (UIMessage | RemoveUIMessage)[] | UIMessage | RemoveUIMessage;
      };
      CustomEventType: UIMessage | RemoveUIMessage;
    }
  >({
    apiUrl: API_URL,
    assistantId: ASSISTANT_ID,
    messagesKey: 'messages',
    threadId: threadIdFromUrl,
    // Handle custom UI events from graph nodes (push_ui_message)
    onCustomEvent: (event, options) => {
      if (isUIMessage(event) || isRemoveUIMessage(event)) {
        options.mutate(prev => {
          const ui = uiMessageReducer(prev.ui ?? [], event);
          return { ...prev, ui };
        });
      }
    },
    onThreadId: id => {
      // Update URL when thread ID changes
      if (id !== threadIdFromUrl) {
        navigate(`/chat?thread=${id}`, { replace: false });
        // Refresh threads list after a delay
        setTimeout(() => fetchThreads(), 1000);
      }
    },
  });

  // Build current thread from stream data and threads list
  const currentThread = useMemo<Thread | null>(() => {
    if (!threadIdFromUrl) return null;

    // Find thread metadata from threads list
    const threadMetadata = threads.find(t => t.thread_id === threadIdFromUrl);

    // Return the thread metadata if available
    return threadMetadata || null;
  }, [threadIdFromUrl, threads]);

  const refreshThreads = async () => {
    await fetchThreads();
  };

  const createThread = async (): Promise<Thread> => {
    if (!langGraphClient) {
      throw new Error('LangGraph client not initialized');
    }

    const langGraphThread = await langGraphClient.threads.create({
      metadata: {
        title: 'New Conversation',
        created_by: 'threadwise-ui',
      },
    });

    // Navigate to new thread
    navigate(`/chat?thread=${langGraphThread.thread_id}`, { replace: false });

    // Refresh threads list
    await fetchThreads();

    return langGraphThread;
  };

  const selectThread = (threadId: string) => {
    navigate(`/chat?thread=${threadId}`);
  };

  const deleteThread = async (threadId: string) => {
    if (!langGraphClient) return;

    try {
      await langGraphClient.threads.delete(threadId);

      if (currentThread?.thread_id === threadId) {
        navigate('/chat');
      }

      await fetchThreads();
    } catch (error) {
      console.error('Failed to delete thread:', error);
    }
  };

  const sendMessage = async (content: string, attachments?: Base64ContentBlock[]) => {
    if (!langGraphClient) return;

    // Require either text content or attachments
    if (!content.trim() && (!attachments || attachments.length === 0)) return;

    const isFirstMessage = !currentThread || stream.messages.length === 0;

    // Build message content - either string or array of content blocks
    let messageContent:
      | string
      | Array<{
          type: string;
          text?: string;
          source_type?: string;
          mime_type?: string;
          data?: string;
          metadata?: Record<string, string>;
        }>;

    if (attachments && attachments.length > 0) {
      // Multimodal message with attachments
      const contentBlocks: Array<{
        type: string;
        text?: string;
        source_type?: string;
        mime_type?: string;
        data?: string;
        metadata?: Record<string, string>;
      }> = [];

      // Add text content if present
      if (content.trim()) {
        contentBlocks.push({ type: 'text', text: content });
      }

      // Add file attachments
      for (const attachment of attachments) {
        if (attachment.type === 'image') {
          contentBlocks.push({
            type: 'image',
            source_type: 'base64',
            mime_type: attachment.mime_type,
            data: attachment.data,
            metadata: attachment.metadata as Record<string, string>,
          });
        } else if (attachment.type === 'file') {
          contentBlocks.push({
            type: 'file',
            source_type: 'base64',
            mime_type: attachment.mime_type,
            data: attachment.data,
            metadata: attachment.metadata as Record<string, string>,
          });
        }
      }

      messageContent = contentBlocks;
    } else {
      // Simple text message
      messageContent = content;
    }

    // Create new human message
    const newHumanMessage: Message = {
      id: uuidv4(),
      type: 'human',
      content: messageContent,
    };

    // Auto-generate title for first message
    if (isFirstMessage && currentThread) {
      const newTitle = generateThreadTitle(content || 'Document analysis');

      try {
        await updateThreadMetadata(langGraphClient, currentThread.thread_id, {
          title: newTitle,
          created_by: 'threadwise-ui',
          auto_titled: true,
          first_message: (content || 'Document analysis').substring(0, 100),
        });

        // Refresh threads to show new title
        setTimeout(() => fetchThreads(), 500);
      } catch (error) {
        console.error('Failed to update thread title:', error);
      }
    }

    // Submit to LangGraph with optimistic update
    try {
      await stream.submit(
        { messages: [newHumanMessage], model: selectedModel, data_source: selectedDataSource },
        {
          streamMode: ['values'],
          streamSubgraphs: true,
          streamResumable: true,
          optimisticValues: prev => ({
            ...prev,
            messages: [...(prev.messages ?? []), newHumanMessage],
          }),
          context: { user_id: 'user_123' },
          // command: { update: { model: 'local' } },
        }
      );
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const stopGeneration = () => {
    stream.stop();
  };

  // Extract UI messages from stream values
  const uiMessages = stream.values?.ui ?? [];

  const value: ChatContextType = {
    threads,
    currentThread,
    selectedModel,
    selectedDataSource,
    availableDataSources,
    error: stream.error ? String(stream.error) : null,
    createThread,
    selectThread,
    deleteThread,
    sendMessage,
    refreshThreads,
    isStreaming: stream.isLoading,
    stopGeneration,
    messages: stream.messages,
    setSelectedModel,
    setSelectedDataSource,
    // Expose stream for UI message rendering with for rendering generative UI
    stream,
    // Expose UI messages for filtering by message ID
    uiMessages,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
