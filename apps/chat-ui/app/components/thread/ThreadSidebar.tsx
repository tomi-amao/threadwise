import React, { useState } from "react";
import { useChat } from "~/providers/ChatProvider";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { formatDate } from "~/lib/utils";
import { 
  Plus, 
  ChatCircle, 
  Trash, 
  DotsThree,
  Chat,
  X,
  ArrowClockwise,
  Spinner,
  Copy,
  Check
} from "phosphor-react";

/**
 * ThreadSidebar Component - LangGraph-integrated conversation list interface
 * 
 * Now integrates with real LangGraph server data and URL-based navigation
 * 
 * Features:
 * - Real thread data from LangGraph server
 * - URL-based thread navigation with query parameters
 * - Thread creation, deletion, and management via LangGraph API
 * - Loading states and error handling
 * - Manual refresh capability
 * - Mobile overlay with close button
 * - Desktop fixed sidebar layout
 */

interface ThreadSidebarProps {
  onClose?: () => void;  // Optional close handler for mobile overlay mode
}

export function ThreadSidebar({ onClose }: ThreadSidebarProps) {
  const { 
    threads, 
    currentThread, 
    createThread, 
    selectThread, 
    deleteThread, 
    refreshThreads,
    error 
  } = useChat();

  const [copiedThreadId, setCopiedThreadId] = useState<string | null>(null);

  /**
   * Handle new thread creation via LangGraph server
   */
  const handleNewThread = async () => {
    try {
      await createThread();
    } catch (error) {
      console.error("Failed to create thread:", error);
      // TODO: Add toast notification for user feedback
    }
  };

  /**
   * Handle thread deletion with confirmation
   */
  const handleDeleteThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("Are you sure you want to delete this conversation?")) {
      await deleteThread(threadId);
    }
  };

  /**
   * Handle thread selection - now uses URL navigation
   */
  const handleSelectThread = (threadId: string) => {
    selectThread(threadId);
    // Mobile: close sidebar after selection
    if (onClose) {
      onClose();
    }
  };

  /**
   * Handle manual refresh of threads from LangGraph server
   */
  const handleRefresh = async () => {
    try {
      await refreshThreads();
    } catch (error) {
      console.error("Failed to refresh threads:", error);
    }
  };

  /**
   * Handle copying thread ID to clipboard
   */
  const handleCopyThreadId = async (threadId: string) => {
    try {
      await navigator.clipboard.writeText(threadId);
      setCopiedThreadId(threadId);
      setTimeout(() => setCopiedThreadId(null), 2000);
    } catch (error) {
      console.error("Failed to copy thread ID:", error);
    }
  };

  return (
    <div className="w-80 max-w-[85vw] lg:max-w-none bg-sidebar border-r border-sidebar-border flex flex-col h-full">
      {/* 
        Sidebar Header with LangGraph integration indicators
      */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Chat size={24} className="text-sidebar-primary" weight="duotone" />
            <h1 className="text-lg font-semibold text-sidebar-foreground">ThreadWise</h1>
          </div>
          
          {/* Mobile-only close button */}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 lg:hidden"
            >
              <X size={20} weight="bold" />
            </Button>
          )}
        </div>
        
        {/* Action buttons row */}
        <div className="flex gap-2">
          {/* Primary action: Create new conversation */}
          <Button 
            onClick={handleNewThread}
            className="flex-1 bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground"
            size="sm"
          >
            <Plus size={16} weight="bold" />
            New Chat
          </Button>
          
          {/* Refresh button to sync with LangGraph server */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            className="px-3"
            title="Refresh threads from server"
          >
            <ArrowClockwise size={16} weight="bold" />
          </Button>
        </div>

        {/* Error message display */}
        {error && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
      </div>

      {/* 
        Thread List Container with loading states
      */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {threads.length === 0 ? (
          // Empty state
          <div className="p-4 text-center">
            <ChatCircle size={32} className="mx-auto mb-2 text-muted-foreground" weight="duotone" />
            <p className="text-sm text-muted-foreground mb-2">No conversations yet</p>
            <p className="text-xs text-muted-foreground">
              Create your first conversation to start chatting with ThreadWise AI
            </p>
          </div>
        ) : (
          // Thread list with real LangGraph data
          threads.map((thread) => {
            const isActive = currentThread?.thread_id === thread.thread_id;
            const isCopied = copiedThreadId === thread.thread_id;
            
            return (
              <ContextMenu key={thread.thread_id}>
                <ContextMenuTrigger asChild>
                  <Card
                    className={`p-3 cursor-pointer transition-all duration-200 hover:bg-sidebar-accent group ${
                      isActive 
                        ? 'bg-sidebar-accent border-sidebar-primary/50 shadow-sm' 
                        : 'bg-transparent border-transparent hover:border-sidebar-border'
                    }`}
                    onClick={() => handleSelectThread(thread.thread_id)}
                  >
                    <div className="flex items-start justify-between">
                      {/* Thread Information */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {/* Thread title with truncation */}
                          <h3 className="font-medium text-sm text-sidebar-foreground truncate">
                            {thread.metadata?.title || 'New Conversation'}
                          </h3>
                          
                          {/* Status indicator for interrupted threads */}
                          {thread.status === 'interrupted' && (
                            <div className="w-2 h-2 bg-yellow-500 rounded-full shrink-0" />
                          )}
                          
                          {/* Active thread indicator */}
                          {isActive && (
                            <div className="w-2 h-2 bg-sidebar-primary rounded-full shrink-0" />
                          )}
                        </div>
                        
                        {/* Thread metadata */}
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-xs text-muted-foreground">
                            {formatDate(thread.updated_at)}
                          </p>
                          
                          {/* LangGraph thread ID for debugging */}
                          {import.meta.env.DEV && (
                            <>
                              <span className="text-xs text-muted-foreground">•</span>
                              <p className="text-xs text-muted-foreground font-mono">
                                {thread.thread_id.substring(0, 8)}...
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                      
                      {/* 
                        Hover Actions
                      */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={(e) => handleDeleteThread(thread.thread_id, e)}
                          title="Delete conversation"
                        >
                          <Trash size={12} />
                        </Button>
                      </div>
                    </div>
                  </Card>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem onClick={() => handleCopyThreadId(thread.thread_id)}>
                    {isCopied ? (
                      <>
                        <Check size={16} className="mr-2" weight="bold" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy size={16} className="mr-2" weight="duotone" />
                        Copy Thread ID
                      </>
                    )}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={(e) => handleDeleteThread(thread.thread_id, e as any)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash size={16} className="mr-2" weight="duotone" />
                    Delete Thread
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>

      {/* 
        Sidebar Footer with server connection status
      */}
      <div className="p-4 border-t border-sidebar-border">
        <div className="text-xs text-muted-foreground text-center space-y-1">
          <div>
            {threads.length} conversation{threads.length !== 1 ? 's' : ''}
          </div>
          
          {/* Connection status indicator */}
          <div className="flex items-center justify-center gap-1">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
            <span>Connected to LangGraph</span>
          </div>
          
          {/* Development info */}
          {import.meta.env.DEV && (
            <div className="text-xs text-muted-foreground/60">
              {import.meta.env.VITE_LANGGRAPH_API_URL || 'http://localhost:2024'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}