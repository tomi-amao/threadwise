/**
 * /chat: the assistant full width (the panel's "Open full width"), with the conversations
 * beside it. The same conversation as the panel; `?thread=<id>` opens a given one, so a link
 * to a conversation works. The panel itself is hidden on this page.
 */

import { useState } from 'react';
import type { MetaFunction } from 'react-router';
import { ClockCounterClockwise } from 'phosphor-react';
import { Conversation } from '~/components/assistant/Conversation';
import { ThreadList, threadTitle } from '~/components/assistant/ThreadList';
import { Eyebrow } from '~/components/ui/eyebrow';
import { cn } from '~/lib/utils';
import { useAssistant } from '~/providers/AssistantProvider';

export const meta: MetaFunction = () => [
  { title: 'Assistant - ThreadWise' },
  { name: 'description', content: 'Ask about your business data' },
];

export default function ChatPage() {
  const assistant = useAssistant();
  const [showList, setShowList] = useState(false);
  const current = assistant.threads.find(t => t.thread_id === assistant.threadId);

  return (
    // Full height under the phone header (65px), full height beside the sidebar on desktop.
    <div className="flex h-[calc(100dvh-65px)] lg:h-dvh">
      <aside
        aria-label="Conversations"
        className={cn(
          'w-full shrink-0 flex-col border-r p-4 lg:flex lg:w-72',
          showList ? 'flex' : 'hidden'
        )}
      >
        <ThreadList onOpen={() => setShowList(false)} />
      </aside>
      <section
        aria-labelledby="chat-title"
        className={cn('min-w-0 flex-1 flex-col', showList ? 'hidden lg:flex' : 'flex')}
      >
        <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 lg:px-8">
          <div className="min-w-0 flex-1">
            <Eyebrow>Assistant</Eyebrow>
            <h1 id="chat-title" className="truncate font-serif text-xl">
              {threadTitle(current)}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setShowList(true)}
            aria-label="Conversations"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <ClockCounterClockwise size={18} aria-hidden />
          </button>
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col lg:px-4">
          <Conversation />
        </div>
      </section>
    </div>
  );
}
