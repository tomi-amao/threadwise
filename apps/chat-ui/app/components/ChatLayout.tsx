import React, { useEffect, useState } from "react";
import { useChat } from "~/providers/ChatProvider";
import { ThreadSidebar } from "./thread/ThreadSidebar";
import { ChatArea } from "./thread/ChatArea";
import { Button } from "./ui/button";
import { List, ChatCircle } from "phosphor-react";

/**
 * ChatLayout Component - Main responsive layout manager for ThreadWise chat interface
 * 
 * Features:
 * - Mobile-first responsive design with sidebar overlay
 * - Desktop fixed sidebar layout
 * - Welcome screen when no thread selected
 * - Mobile navigation with hamburger menu
 * 
 * Layout Strategy:
 * - Mobile (< 1024px): Overlay sidebar with backdrop
 * - Desktop (>= 1024px): Fixed sidebar layout
 */
export function ChatLayout() {
  const { threads, currentThread, createThread } = useChat();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Mobile UX: Auto-close sidebar when thread is selected
  // Provides seamless navigation on small screens
  useEffect(() => {
    if (currentThread) {
      setSidebarOpen(false);
    }
  }, [currentThread]);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Mobile Sidebar Overlay System */}
      <div className={`
        fixed inset-0 z-40 lg:hidden transition-opacity duration-300
        ${sidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}
      `}>
        {/* Semi-transparent backdrop with blur effect */}
        <div 
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
        {/* Sidebar container with slide animation */}
        <div className={`
          absolute left-0 top-0 h-full w-80 max-w-[85vw] transition-transform duration-300
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          <ThreadSidebar onClose={() => setSidebarOpen(false)} />
        </div>
      </div>

      {/* Desktop Sidebar - Hidden on mobile, visible on large screens */}
      <div className="hidden lg:block">
        <ThreadSidebar />
      </div>

      {/* Main Content Area - Flexible layout for chat interface */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile Header Bar */}
        <div className="lg:hidden border-b border-border bg-card/95 backdrop-blur-sm p-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            {/* Hamburger menu button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(true)}
              className="h-8 w-8"
            >
              <List size={20} weight="bold" />
            </Button>
            
            {/* Centered ThreadWise logo/title */}
            <h1 className="text-lg font-semibold">ThreadWise</h1>
            
            {/* Spacer for perfect centering */}
            <div className="w-8" />
          </div>
        </div>

        {/* Conditional Content Rendering */}
        {currentThread ? (
          <ChatArea />
        ) : (
          <div className="flex-1 flex items-center justify-center p-4 md:p-8">
            <div className="text-center space-y-6 max-w-md">
              {/* ThreadWise branding */}
              <div className="space-y-3">
                <div className="w-16 h-16 md:w-20 md:h-20 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto">
                  <ChatCircle size={32} className="text-primary md:hidden" weight="duotone" />
                  <ChatCircle size={40} className="text-primary hidden md:block" weight="duotone" />
                </div>
                <div className="space-y-2">
                  <h1 className="text-2xl md:text-3xl font-bold text-foreground">
                    Welcome to ThreadWise
                  </h1>
                  <p className="text-sm md:text-base text-muted-foreground">
                    AI-powered conversational business intelligence platform
                  </p>
                </div>
              </div>

              {/* Action buttons */}
              <div className="space-y-3">
                <Button
                  onClick={createThread}
                  size="lg"
                  className="w-full md:w-auto md:min-w-[200px] shadow-md"
                >
                  <ChatCircle size={20} weight="bold" className="mr-2" />
                  Start New Conversation
                </Button>

                {threads.length > 0 && (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground">or</span>
                      <div className="flex-1 h-px bg-border" />
                    </div>

                    <Button
                      onClick={() => setSidebarOpen(true)}
                      variant="outline"
                      size="lg"
                      className="w-full md:w-auto md:min-w-[200px]"
                    >
                      <List size={20} weight="bold" className="mr-2" />
                      Browse Conversations ({threads.length})
                    </Button>
                  </>
                )}
              </div>

              {/* Helper text */}
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Ask me anything about your business data, analytics, or get insights from your connected platforms.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}