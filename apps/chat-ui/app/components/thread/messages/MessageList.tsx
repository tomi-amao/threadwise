import React, { useEffect, useRef } from "react";
import { useChat } from "~/providers/ChatProvider";
import { MessageBubble } from "./MessageBubble";
import { ChatCircle } from "phosphor-react";

export function MessageList() {
  const { messages, isStreaming } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="max-w-4xl mx-auto p-3 md:p-4 space-y-3 md:space-y-4">
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-8 md:py-12">
            <div className="text-center space-y-4 px-4">
              <div className="w-12 h-12 md:w-16 md:h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
                <ChatCircle size={24} className="text-primary md:hidden" weight="duotone" />
                <ChatCircle size={32} className="text-primary hidden md:block" weight="duotone" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base md:text-lg font-semibold">Start a conversation</h3>
                <p className="text-sm md:text-base text-muted-foreground max-w-sm mx-auto">
                  Ask me anything about your business data or analytics.
                </p>
              </div>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))
        )}
        
        {isStreaming && (
          <div className="flex justify-start">
            <div className="max-w-xs lg:max-w-md bg-card border border-border rounded-2xl p-3 md:p-4">
              <div className="flex items-center space-x-2">
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                  <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                  <div className="w-2 h-2 bg-primary rounded-full animate-bounce"></div>
                </div>
                <span className="text-xs md:text-sm text-muted-foreground">ThreadWise is thinking...</span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}