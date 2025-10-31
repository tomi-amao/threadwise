import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import { useStream } from '@langchain/langgraph-sdk/react'
import { Client, Thread, Message } from '@langchain/langgraph-sdk'
import { useNavigate, useSearchParams } from 'react-router'
import { v4 as uuidv4 } from 'uuid'

/**
 * ThreadWise Chat Provider - Client-side only architecture
 * 
 * Uses LangGraph SDK types directly - no conversion overhead
 * Single source of truth: useStream hook
 * Configuration is handled entirely through environment variables
 */

// Configuration from environment variables - no runtime changes allowed
const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL || 'http://localhost:2024'
const ASSISTANT_ID = import.meta.env.VITE_LANGGRAPH_ASSISTANT_ID || 'threadwise-financial-agent'

interface ChatState {
  threads: Thread[]
  currentThread: Thread | null
  error: string | null
}

interface ChatContextType extends ChatState {
  createThread: () => Promise<Thread>
  selectThread: (threadId: string) => void
  deleteThread: (threadId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  refreshThreads: () => Promise<void>
  isStreaming: boolean
  stopGeneration: () => void
  messages: Message[]
}

const ChatContext = createContext<ChatContextType | null>(null)

// Module-level client (initialized once with env variables)
let langGraphClient: Client | null = null

function generateThreadTitle(firstMessage: string): string {
  const cleaned = firstMessage.trim().replace(/\n+/g, ' ')
  const maxLength = 50
  
  if (cleaned.length <= maxLength) {
    return cleaned
  }
  
  const truncated = cleaned.substring(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  
  return lastSpace > 0 
    ? truncated.substring(0, lastSpace) + '...'
    : truncated + '...'
}

async function updateThreadMetadata(
  client: Client,
  threadId: string,
  metadata: Record<string, any>
): Promise<void> {
  try {
    await client.threads.update(threadId, { metadata })
  } catch (error) {
    console.error('Failed to update thread metadata:', error)
    throw error
  }
}

interface ChatProviderProps {
  children: React.ReactNode
}

export function ChatProvider({ children }: ChatProviderProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const threadIdFromUrl = searchParams.get('thread')

  // Initialize LangGraph client once
  useEffect(() => {
    if (!langGraphClient) {
      langGraphClient = new Client({
        apiUrl: API_URL,
      })
    }
  }, [])

  // Threads state
  const [threads, setThreads] = useState<Thread[]>([])

  // Fetch threads from LangGraph
  const fetchThreads = useCallback(async () => {
    if (!langGraphClient) return []
    
    try {
      const threadsResponse = await langGraphClient.threads.search({ limit: 100 })
      setThreads(threadsResponse)
      return threadsResponse
    } catch (error) {
      console.error('Failed to fetch threads:', error)
      return []
    }
  }, [])

  // Load threads on mount
  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])

  // useStream hook - single source of truth for messages
  const stream = useStream<{ messages: Message[] }>({
    apiUrl: API_URL,
    assistantId: ASSISTANT_ID,
    messagesKey: "messages",
    threadId: threadIdFromUrl,
    onThreadId: (id) => {
      // Update URL when thread ID changes
      if (id !== threadIdFromUrl) {
        navigate(`/?thread=${id}`, { replace: false })
        // Refresh threads list after a delay
        setTimeout(() => fetchThreads(), 1000)
      }
    },
  })

  // Build current thread from stream data and threads list
  const currentThread = useMemo<Thread | null>(() => {
    if (!threadIdFromUrl) return null

    // Find thread metadata from threads list
    const threadMetadata = threads.find(t => t.thread_id === threadIdFromUrl)
    
    // Return the thread metadata if available
    return threadMetadata || null
  }, [threadIdFromUrl, threads])

  const refreshThreads = async () => {
    await fetchThreads()
  }

  const createThread = async (): Promise<Thread> => {
    if (!langGraphClient) {
      throw new Error('LangGraph client not initialized')
    }
    
    const langGraphThread = await langGraphClient.threads.create({
      metadata: {
        title: 'New Conversation',
        created_by: 'threadwise-ui',
      }
    })
    
    // Navigate to new thread
    navigate(`/?thread=${langGraphThread.thread_id}`, { replace: false })
    
    // Refresh threads list
    await fetchThreads()

    return langGraphThread
  }

  const selectThread = (threadId: string) => {
    navigate(`/?thread=${threadId}`)
  }

  const deleteThread = async (threadId: string) => {
    if (!langGraphClient) return

    try {
      await langGraphClient.threads.delete(threadId)

      if (currentThread?.thread_id === threadId) {
        navigate('/')
      }
      
      await fetchThreads()
    } catch (error) {
      console.error('Failed to delete thread:', error)
    }
  }

  const sendMessage = async (content: string) => {
    if (!langGraphClient || !content.trim()) return

    const isFirstMessage = !currentThread || stream.messages.length === 0
    
    // Create new human message
    const newHumanMessage: Message = {
      id: uuidv4(),
      type: 'human',
      content: content,
    }

    // Auto-generate title for first message
    if (isFirstMessage && currentThread) {
      const newTitle = generateThreadTitle(content)
      
      try {
        await updateThreadMetadata(
          langGraphClient,
          currentThread.thread_id,
          {
            title: newTitle,
            created_by: 'threadwise-ui',
            auto_titled: true,
            first_message: content.substring(0, 100),
          }
        )
        
        // Refresh threads to show new title
        setTimeout(() => fetchThreads(), 500)
      } catch (error) {
        console.error('Failed to update thread title:', error)
      }
    }

    // Submit to LangGraph with optimistic update
    try {
      await stream.submit(
        { messages: [newHumanMessage] },
        {
          streamMode: ["values"],
          streamSubgraphs: true,
          streamResumable: true,
          optimisticValues: (prev) => ({
            ...prev,
            messages: [...(prev.messages ?? []), newHumanMessage],
          }),
        }
      )
    } catch (error) {
      console.error('Error sending message:', error)
    }
  }

  const stopGeneration = () => {
    stream.stop()
  }

  const value: ChatContextType = {
    threads,
    currentThread,
    error: stream.error ? String(stream.error) : null,
    createThread,
    selectThread,
    deleteThread,
    sendMessage,
    refreshThreads,
    isStreaming: stream.isLoading,
    stopGeneration,
    messages: stream.messages,
  }

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChat() {
  const context = useContext(ChatContext)
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider')
  }
  return context
}