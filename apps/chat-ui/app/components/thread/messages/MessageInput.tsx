import React, { useState, useRef, useEffect } from "react";
import { useChat } from "~/providers/ChatProvider";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { PaperPlaneRight, Stop } from "phosphor-react";
import { cn } from "~/lib/utils";

/**
 * MessageInput Component - LangGraph SDK integrated message input interface
 * 
 * Now uses real LangGraph SDK integration for streaming responses and stop functionality
 * 
 * Features:
 * - Auto-resizing textarea (48px-120px height range)
 * - Mobile-optimized touch targets and typography
 * - Enter/Shift+Enter keyboard shortcuts
 * - Character count and input validation
 * - Real LangGraph SDK stop functionality via stopGeneration
 * - Auto-focus on thread selection
 * 
 * LangGraph Integration:
 * - Uses real streaming responses from useStream hook
 * - Implements proper stop functionality for AI generation
 * - Syncs with LangGraph SDK loading states
 */
export function MessageInput() {
  const { sendMessage, isStreaming, currentThread, stopGeneration } = useChat();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Handle form submission and message sending
   * 
   * Validates input, clears the form, resets textarea height,
   * and sends message to LangGraph AI Agent via SDK
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !currentThread) return;

    const message = input.trim();
    setInput("");
    
    // Reset textarea height to auto after sending
    // This prevents UI jumping when switching between threads
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    
    await sendMessage(message);
  };

  /**
   * Handle keyboard shortcuts for message sending
   * 
   * - Enter: Send message (unless Shift is held)
   * - Shift+Enter: Insert new line
   * 
   * Follows chat application conventions for intuitive UX
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  /**
   * Handle input changes with auto-resize functionality
   * 
   * Automatically adjusts textarea height based on content
   * Height constraints: 48px (mobile) / 52px (desktop) minimum, 120px maximum
   * Provides smooth UX without manual textarea resizing
   */
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    
    // Auto-resize textarea based on content
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  /**
   * Auto-focus input when thread selection changes
   * 
   * Improves UX by immediately focusing the input when user
   * selects a new thread, ready for message composition
   */
  useEffect(() => {
    if (currentThread && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [currentThread]);

  // Don't render if no thread is selected
  if (!currentThread) return null;

  return (
    <div className="border-t border-border bg-card/50 backdrop-blur-sm">
      <div className="max-w-4xl mx-auto p-3 md:p-4">
        <form onSubmit={handleSubmit} className="space-y-2 md:space-y-3">
          <div className="relative">
            {/* 
              Main textarea input with responsive sizing
              - Mobile: 48px min-height, smaller text
              - Desktop: 52px min-height, larger text
              - Auto-resize up to 120px maximum
              - Right padding for send button placement
            */}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask ThreadWise about your business data..."
              disabled={isStreaming}
              className={cn(
                "min-h-[48px] md:min-h-[52px] max-h-[120px] resize-none pr-12 md:pr-14 bg-background border-border focus:border-primary transition-colors",
                "placeholder:text-muted-foreground text-sm md:text-base"
              )}
              rows={1}
            />
            
            {/* 
              Action button positioned over textarea
              - Loading state: Shows stop button with real LangGraph SDK stop functionality
              - Ready state: Shows send button with validation
              - Responsive sizing for mobile/desktop
            */}
            <div className="absolute right-2 bottom-2 flex items-center gap-2">
              {isStreaming ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 md:h-9 md:w-9 text-muted-foreground hover:text-foreground"
                  onClick={stopGeneration}
                >
                  <Stop size={16} className="md:hidden" weight="bold" />
                  <Stop size={18} className="hidden md:block" weight="bold" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={!input.trim() || isStreaming}
                  className="h-8 w-8 md:h-9 md:w-9 bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50 touch-manipulation"
                >
                  <PaperPlaneRight size={16} className="md:hidden" weight="bold" />
                  <PaperPlaneRight size={18} className="hidden md:block" weight="bold" />
                </Button>
              )}
            </div>
          </div>
          
          {/* 
            Input help text and character counter
            - Responsive help text (simplified on mobile)
            - Character count with tabular-nums for consistent width
            - Subtle styling with muted colors
          */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-2 md:gap-4">
              {/* Desktop: Full instruction text */}
              <span className="hidden sm:inline">Press Enter to send, Shift+Enter for new line</span>
              {/* Mobile: Simplified instruction */}
              <span className="sm:hidden">Enter to send</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Character counter - only show when user is typing */}
              {input.length > 0 && (
                <span className="tabular-nums">{input.length}</span>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}