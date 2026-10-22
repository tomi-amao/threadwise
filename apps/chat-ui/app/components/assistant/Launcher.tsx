/**
 * Opens and closes the assistant panel. In the sidebar (a nav-sized row, or an icon when the
 * sidebar is collapsed) and in the phone header. On `/chat`, where the conversation is the
 * page, it moves focus to the composer instead.
 */

import { useEffect, useState } from 'react';
import { ChatCircle } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { useOptionalAssistant } from '~/providers/AssistantProvider';

export function AssistantLauncher({
  variant,
  collapsed = false,
  onActivate,
}: {
  variant: 'sidebar' | 'header';
  collapsed?: boolean;
  onActivate?: () => void;
}) {
  const assistant = useOptionalAssistant();
  // Known only in the browser; set after hydration so the server's HTML matches.
  const [shortcut, setShortcut] = useState('Ctrl+J');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut('⌘J');
  }, []);
  // Switched off (lib/assistant-flag.ts): there is nothing to open.
  if (!assistant) return null;
  const { open, toggle, onChatPage, composerRef } = assistant;
  const activate = () => {
    onActivate?.();
    if (onChatPage) composerRef.current?.focus();
    else toggle();
  };

  if (variant === 'header') {
    return (
      <button
        type="button"
        id="assistant-launcher-header"
        onClick={activate}
        aria-label="Ask ThreadWise"
        aria-expanded={onChatPage ? undefined : open}
        aria-controls={open ? 'assistant-panel' : undefined}
        className="inline-flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChatCircle size={20} weight="light" aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      id="assistant-launcher"
      onClick={activate}
      aria-expanded={onChatPage ? undefined : open}
      aria-controls={open ? 'assistant-panel' : undefined}
      aria-keyshortcuts="Meta+J Control+J"
      title={collapsed ? `Ask ThreadWise (${shortcut})` : undefined}
      aria-label={collapsed ? 'Ask ThreadWise' : undefined}
      className={cn(
        'relative flex w-full items-center gap-3 rounded-xl text-sm font-medium transition-colors duration-200',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        collapsed ? 'justify-center px-3 py-3' : 'px-4 py-3',
        open || onChatPage
          ? 'bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary'
          : 'text-sidebar-foreground/70'
      )}
    >
      <ChatCircle size={20} weight="light" aria-hidden />
      {!collapsed && (
        <>
          <span className="flex-1 text-left">Ask ThreadWise</span>
          {/* aria-keyshortcuts announces it; the name stays "Ask ThreadWise". */}
          <kbd aria-hidden className="font-mono text-[11px] text-muted-foreground">
            {shortcut}
          </kbd>
        </>
      )}
    </button>
  );
}
