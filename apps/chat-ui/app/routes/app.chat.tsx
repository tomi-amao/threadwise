/**
 * Chat Route (Protected)
 *
 * AI chat interface for conversational business intelligence.
 */

import type { MetaFunction } from 'react-router';
import { ChatProvider } from '~/providers/ChatProvider';
import { ChatInterface } from '~/components/ChatInterface';

export const meta: MetaFunction = () => {
  return [
    { title: 'Ask AI - ThreadWise' },
    { name: 'description', content: 'Chat with AI about your business data' },
  ];
};

export default function ChatPage() {
  return (
    <ChatProvider>
      <ChatInterface />
    </ChatProvider>
  );
}
