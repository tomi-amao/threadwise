import React from "react";
import { useChat } from "~/providers/ChatProvider";
import { MessageList } from "./messages/MessageList";
import { MessageInput } from "./messages/MessageInput";
import { Robot, User } from "phosphor-react";

/**
 * ChatArea Component - Main conversation interface for ThreadWise
 * 
 * Provides the primary chat interface where users interact with ThreadWise AI Agent
 * 
 * Features:
 * - Responsive layout with desktop header/mobile header in ChatLayout
 * - Message list with scrolling and auto-focus
 * - Message input with auto-resize and validation
 * - AI Agent status indicators (thinking, interruptions)
 * - Empty state handling for no thread selection
 * 
 * Layout Strategy:
 * - Desktop: Shows header with assistant info and status
 * - Mobile: Header handled by ChatLayout for better space usage
 * - Flexible message area with input pinned to bottom
 * 
 * Integration Points:
 * - Uses ChatProvider for current thread and loading state
 * - Integrates with ThreadWise AI Agent API via ChatProvider
 */
export function ChatArea() {
  const { currentThread, isStreaming } = useChat();

  // Guard clause: Don't render if no thread selected
  if (!currentThread) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-md">
          <div className="text-xl md:text-2xl font-semibold text-muted-foreground">
            No conversation selected
          </div>
          <p className="text-sm md:text-base text-muted-foreground">
            Choose a conversation from the sidebar or start a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background overflow-hidden">
      {/* 
        Desktop Header - Hidden on mobile for space efficiency
        - Shows ThreadWise AI Agent branding and status
        - Displays current thread title and assistant info
        - Real-time status indicators (thinking, interrupted)
        - Glassmorphism effect with backdrop blur
      */}
      <div className="hidden lg:block border-b border-border p-4 bg-card/50 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* AI Agent avatar with ThreadWise branding */}
            <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
              <Robot size={18} className="text-primary" weight="duotone" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">
                {currentThread.metadata?.title || 'ThreadWise Assistant'}
              </h2>
              <p className="text-sm text-muted-foreground">
                AI-powered business intelligence
              </p>
            </div>
          </div>
          
          {/* 
            Real-time Status Indicators
            - Interrupted: Shows when agent processing was stopped
            - Thinking: Shows when AI is processing user message
            - Future: Could show tool execution status, progress, etc.
          */}
          <div className="flex items-center gap-2">
            {currentThread.status === 'interrupted' && (
              <div className="flex items-center gap-2 px-2 py-1 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-md text-sm">
                <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
                Interrupted
              </div>
            )}
            {isStreaming && (
              <div className="flex items-center gap-2 px-2 py-1 bg-primary/10 text-primary rounded-md text-sm">
                <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                Thinking...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 
        Main Chat Interface
        - MessageList: Scrollable conversation history
        - MessageInput: Fixed input area at bottom
        - Flexible layout that works on all screen sizes
        - Auto-scroll behavior handled by MessageList
      */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <MessageList />
        <MessageInput />
      </div>
    </div>
  );
}