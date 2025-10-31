import React from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { User, Robot, Wrench } from "phosphor-react";
import { cn } from "~/lib/utils";
import { MarkdownText } from "./MarkdownText";
import { ToolCalls, ToolResult } from "./ToolCalls";

/**
 * MessageBubble Component - Individual message display in ThreadWise conversations
 * 
 * Renders individual chat messages with role-based styling and metadata
 * 
 * Features:
 * - Role-based visual styling (human, AI, tool)
 * - Clear message type indicators
 * - Mobile-responsive sizing and spacing
 * - Tool call execution display with status indicators
 * - Rich content support (text, React components)
 * - Timestamp formatting with consistent display
 * - Word wrapping and overflow handling
 * 
 * Visual Design:
 * - Human messages: Blue background, right-aligned
 * - AI messages: Card background, left-aligned with border
 * - Tool messages: Amber accent, system-style presentation
 * - Responsive avatar sizes (14px mobile, 16px desktop)
 * 
 * ThreadWise Integration:
 * - Supports tool call metadata from AI Agent API
 * - Displays ThreadWise agent reasoning and external API calls
 * - Future: Will show artifacts, code execution, file attachments
 */

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.type === 'human';
  const isAI = message.type === 'ai';
  const isTool = message.type === 'tool';

  // Tool messages get special rendering with clear type indicator
  if (isTool) {
    return (
      <div className="flex gap-2 md:gap-3">
        <div className="w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center text-white shrink-0 bg-amber-500">
          <Wrench size={14} className="md:hidden" weight="duotone" />
          <Wrench size={16} className="hidden md:block" weight="duotone" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-xs font-semibold text-amber-700 dark:text-amber-300">
              <Wrench size={12} weight="bold" />
              TOOL EXECUTION
            </span>
          </div>
          <ToolResult message={message} />
        </div>
      </div>
    );
  }

  const getIcon = () => {
    if (isUser) return <User size={14} className="md:hidden" weight="duotone" />;
    return <Robot size={14} className="md:hidden" weight="duotone" />;
  };

  const getDesktopIcon = () => {
    if (isUser) return <User size={16} className="hidden md:block" weight="duotone" />;
    return <Robot size={16} className="hidden md:block" weight="duotone" />;
  };

  const getIconBg = () => {
    if (isUser) return "bg-blue-500";
    return "bg-primary";
  };

  const getMessageTypeLabel = () => {
    if (isUser) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/30 text-xs font-semibold text-blue-700 dark:text-blue-300">
          <User size={12} weight="bold" />
          YOU
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/20 border border-primary/30 text-xs font-semibold text-primary">
        <Robot size={12} weight="bold" />
        AI ASSISTANT
      </span>
    );
  };

  // Extract content as string from LangGraph Message
  const getContentString = (): string => {
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      // Handle complex content - extract text parts
      return message.content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part.type === 'text' && part.text) return part.text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  };

  const contentString = getContentString();

  return (
    <div className={cn(
      "flex gap-2 md:gap-3",
      isUser ? "flex-row-reverse" : "flex-row"
    )}>
      <div className={cn(
        "w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center text-white shrink-0",
        getIconBg()
      )}>
        {getIcon()}
        {getDesktopIcon()}
      </div>

      <div className="flex flex-col gap-2 max-w-[280px] sm:max-w-xs lg:max-w-md">
        {/* Message Type Label */}
        <div className={cn(
          "flex",
          isUser ? "justify-end" : "justify-start"
        )}>
          {getMessageTypeLabel()}
        </div>

        <div className={cn(
          "rounded-2xl p-3 md:p-4 space-y-2",
          isUser 
            ? "bg-blue-500 text-white ml-8 md:ml-12"
            : "bg-card border border-border text-card-foreground mr-8 md:mr-12"
        )}>
          {/* Render AI messages with markdown support */}
          {isAI ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownText>{contentString}</MarkdownText>
            </div>
          ) : (
            <div className={cn(
              "text-sm leading-relaxed break-words",
              isUser ? "text-white" : "text-foreground"
            )}>
              {contentString}
            </div>
          )}

          {/* Render tool calls if present in AI messages */}
          {'tool_calls' in message && message.tool_calls && message.tool_calls.length > 0 && (
            <div className="pt-2">
              <ToolCalls toolCalls={message.tool_calls} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}