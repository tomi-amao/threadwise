import React, { useState, useRef, useEffect } from 'react';
import { useChat } from '~/providers/ChatProvider';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { PaperPlaneRight, Stop, Paperclip, Robot, Sparkle } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { useFileUpload } from '~/hooks/use-file-upload';
import { ContentBlocksPreview } from '../ContentBlocksPreview';

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
 * - File upload (drag-and-drop, paste, and file picker)
 * - Supports images (JPEG, PNG, GIF, WEBP) and PDFs
 *
 * LangGraph Integration:
 * - Uses real streaming responses from useStream hook
 * - Implements proper stop functionality for AI generation
 * - Syncs with LangGraph SDK loading states
 * - Sends multimodal messages with file attachments
 */
export function MessageInput() {
  const {
    sendMessage,
    isStreaming,
    currentThread,
    stopGeneration,
    selectedModel,
    setSelectedModel,
  } = useChat();
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // File upload hook
  const {
    contentBlocks,
    handleFileUpload,
    dropRef,
    removeBlock,
    resetBlocks,
    dragOver,
    handlePaste,
  } = useFileUpload();

  /**
   * Handle form submission and message sending
   *
   * Validates input, clears the form, resets textarea height,
   * and sends message to LangGraph AI Agent via SDK
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Require either text or attachments
    if ((!input.trim() && contentBlocks.length === 0) || isStreaming || !currentThread) return;

    const message = input.trim();
    setInput('');

    // Reset textarea height to auto after sending
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Send message with attachments
    await sendMessage(message, contentBlocks.length > 0 ? contentBlocks : undefined);

    // Clear attachments after sending
    resetBlocks();
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
    if (e.key === 'Enter' && !e.shiftKey) {
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
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  /**
   * Trigger file input click
   */
  const handleAttachClick = () => {
    fileInputRef.current?.click();
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

  const hasContent = input.trim() || contentBlocks.length > 0;

  return (
    <div
      ref={dropRef}
      className={cn(
        'border-t border-border bg-card/50 backdrop-blur-sm transition-colors',
        dragOver && 'border-primary border-2 border-dashed bg-primary/5'
      )}
    >
      <div className="max-w-4xl mx-auto p-3 md:p-4">
        <form onSubmit={handleSubmit} className="space-y-2 md:space-y-3">
          {/* Attachment preview */}
          <ContentBlocksPreview blocks={contentBlocks} onRemove={removeBlock} size="md" />

          {/* Model Selection Dropdown */}
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-muted-foreground min-w-fit">Model:</label>
            <Select value={selectedModel} onValueChange={setSelectedModel}>
              <SelectTrigger className="w-32 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">
                  <div className="flex items-center gap-2">
                    <Robot size={14} />
                    <span>Local</span>
                  </div>
                </SelectItem>
                <SelectItem value="gemini">
                  <div className="flex items-center gap-2">
                    <Sparkle size={14} />
                    <span>Gemini</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="relative">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileUpload}
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
              className="hidden"
            />

            {/* 
              Main textarea input with responsive sizing
              - Mobile: 48px min-height, smaller text
              - Desktop: 52px min-height, larger text
              - Auto-resize up to 120px maximum
              - Right padding for send button placement
              - Left padding for attach button
            */}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                dragOver ? 'Drop files here...' : 'Ask ThreadWise about your business data...'
              }
              disabled={isStreaming}
              className={cn(
                'min-h-12 md:min-h-[52px] max-h-[120px] resize-none pl-10 md:pl-12 pr-12 md:pr-14 bg-background border-border focus:border-primary transition-colors',
                'placeholder:text-muted-foreground text-sm md:text-base'
              )}
              rows={1}
            />

            {/* Attach button - positioned at left */}
            <div className="absolute left-2 bottom-2 flex items-center">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 md:h-9 md:w-9 text-muted-foreground hover:text-foreground"
                onClick={handleAttachClick}
                disabled={isStreaming}
                title="Attach file (images, PDF)"
              >
                <Paperclip size={16} className="md:hidden" weight="regular" />
                <Paperclip size={18} className="hidden md:block" weight="regular" />
              </Button>
            </div>

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
                  disabled={!hasContent || isStreaming}
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
              <span className="hidden sm:inline">
                Press Enter to send, Shift+Enter for new line • Drag & drop or paste files
              </span>
              {/* Mobile: Simplified instruction */}
              <span className="sm:hidden">Enter to send • Drop files</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Attachment count */}
              {contentBlocks.length > 0 && (
                <span className="text-primary">
                  {contentBlocks.length} file{contentBlocks.length > 1 ? 's' : ''}
                </span>
              )}
              {/* Character counter - only show when user is typing */}
              {input.length > 0 && <span className="tabular-nums">{input.length}</span>}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
