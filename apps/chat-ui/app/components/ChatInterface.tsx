import React from "react";
import { ChatLayout } from "./ChatLayout";

/**
 * ChatInterface Component
 * 
 * Main entry point for the ThreadWise chat application.
 * Configuration is handled entirely through environment variables,
 * so we always render the chat layout directly.
 */
export function ChatInterface() {
  return <ChatLayout />;
}