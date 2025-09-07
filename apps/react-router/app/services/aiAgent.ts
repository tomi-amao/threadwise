/**
 * AI Agent Service
 *
 * This service handles communication with the ThreadWise LangGraph AI agent backend.
 * It provides functions to send messages and receive responses from the agent.
 */

import { Client } from '@langchain/langgraph-sdk';

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResponse {
  content: string;
  error?: string;
}

export interface ThreadInfo {
  thread_id: string;
  assistant_id: string;
}

// Configuration
const LANGGRAPH_SERVER_URL = 'http://localhost:8123';
const AGENT_NAME = 'threadwise-financial-agent';

// Initialize LangGraph client
let client: Client | null = null;
let currentThread: ThreadInfo | null = null;

/**
 * Initialize the LangGraph client
 */
function getClient(): Client {
  if (!client) {
    client = new Client({ apiUrl: LANGGRAPH_SERVER_URL });
  }
  return client;
}

/**
 * Create or get the current thread and assistant
 */
async function ensureThreadAndAssistant(): Promise<ThreadInfo> {
  try {
    const langGraphClient = getClient();

    // Create assistant - using the graphId as the main parameter
    const assistant = await langGraphClient.assistants.create({
      graphId: AGENT_NAME,
      name: 'ThreadWise Assistant',
      config: {},
      metadata: { description: 'Financial AI assistant for ThreadWise' },
    });

    // Create thread
    const thread = await langGraphClient.threads.create();

    const threadInfo: ThreadInfo = {
      thread_id: thread.thread_id,
      assistant_id: assistant.assistant_id,
    };

    currentThread = threadInfo;
    return threadInfo;
  } catch (error) {
    console.error('Error creating thread and assistant:', error);
    throw new Error(
      `Failed to initialize LangGraph session: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Send a message to the AI agent and get a response
 */
export async function sendMessageToAgent(message: string): Promise<AgentResponse> {
  try {
    const langGraphClient = getClient();
    const threadInfo = await ensureThreadAndAssistant();

    // Input format matching your Python test-api.py
    const input = { messages: [{ role: 'human', content: message }] };

    let responseContent = '';

    // Stream the response like in your Python example
    const stream = langGraphClient.runs.stream(threadInfo.thread_id, threadInfo.assistant_id, {
      input,
      streamMode: 'values' as const,
    });

    for await (const event of stream) {
      console.log(`Receiving event of type: ${event.event}`);
      console.log('Event data:', event.data);

      // Extract the response content from the event data
      // This structure might need adjustment based on your actual agent response format
      if (event.data && typeof event.data === 'object') {
        // Look for response content in various possible locations
        const data = event.data as Record<string, unknown>;
        if ('messages' in data && Array.isArray(data.messages)) {
          const lastMessage = data.messages[data.messages.length - 1] as Record<string, unknown>;
          if (lastMessage && 'content' in lastMessage && lastMessage.content) {
            responseContent =
              typeof lastMessage.content === 'string'
                ? lastMessage.content
                : JSON.stringify(lastMessage.content);
          }
        } else if ('content' in data && data.content) {
          responseContent =
            typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
        } else if ('response' in data && data.response) {
          responseContent =
            typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
        }
      }
    }

    // If we didn't get content from streaming, provide a default response
    if (!responseContent) {
      responseContent =
        'I received your message and processed it successfully, but the response format was unexpected. Please check the console for debugging information.';
    }

    return {
      content: responseContent,
    };
  } catch (error) {
    console.error('Error communicating with LangGraph agent:', error);

    // Provide more specific error messages
    let errorMessage = 'Unknown error occurred';
    if (error instanceof Error) {
      errorMessage = error.message;
      if (errorMessage.includes('fetch')) {
        errorMessage =
          "Unable to connect to LangGraph server. Make sure it's running on port 8123.";
      }
    }

    return {
      content: '',
      error: `Failed to communicate with AI agent: ${errorMessage}`,
    };
  }
}

/**
 * Check if the LangGraph server is available
 */
export async function checkAgentHealth(): Promise<boolean> {
  try {
    const langGraphClient = getClient();
    // Try to get assistants list as a health check
    await langGraphClient.assistants.search();
    return true;
  } catch (error) {
    console.error('LangGraph agent health check failed:', error);
    return false;
  }
}

/**
 * Reset the current thread (start a fresh conversation)
 */
export async function resetConversation(): Promise<void> {
  currentThread = null;
}

/**
 * Get the current thread info (for debugging)
 */
export function getCurrentThreadInfo(): ThreadInfo | null {
  return currentThread;
}
