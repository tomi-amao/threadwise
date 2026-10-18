/**
 * App Layout Component
 *
 * Main layout wrapper for authenticated pages: the sidebar, the page, and the assistant
 * panel. The assistant's provider lives here, so a conversation survives navigation.
 */

import React from 'react';
import { Outlet, Navigate } from 'react-router';
import { useAuth } from '~/providers/AuthProvider';
import { SidebarProvider, useSidebar } from '~/providers/SidebarProvider';
import { AssistantProvider, useAssistant } from '~/providers/AssistantProvider';
import { AssistantPanel } from '~/components/assistant/AssistantPanel';
import { AssistantLauncher } from '~/components/assistant/Launcher';
import { DEFAULT_PANEL, type PanelState } from '~/lib/assistant-panel';
import { Sidebar } from './Sidebar';
import { SpinnerGap, List } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';

function AppLayoutContent() {
  const { collapsed, setMobileOpen } = useSidebar();
  const { open, width, onChatPage } = useAssistant();
  // Docked (DOCK_MIN_VIEWPORT and wider, see lib/assistant-panel.ts), the page makes room for
  // the panel but always keeps 1024px beside the full sidebar: the panel gives way first.
  const reserve = open && !onChatPage;
  const style = {
    '--assistant-w': `${width}px`,
    '--assistant-dock': `min(${width}px, calc(100vw - 1280px))`,
  } as React.CSSProperties;

  return (
    <div className="min-h-screen bg-background" style={style}>
      <Sidebar />

      <main
        className={cn(
          'min-h-screen transition-[margin] duration-300 ease-in-out motion-reduce:transition-none',
          collapsed ? 'lg:ml-[72px]' : 'lg:ml-64',
          reserve && 'min-[1700px]:mr-[var(--assistant-dock)]'
        )}
      >
        <div className="sticky top-0 z-30 border-b border-border bg-card/95 p-4 backdrop-blur-sm lg:hidden">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(true)}
              className="h-8 w-8"
              aria-label="Open navigation menu"
              title="Open navigation menu"
            >
              <List size={20} weight="light" />
            </Button>
            <p className="flex-1 text-lg font-medium tracking-tight">ThreadWise</p>
            <AssistantLauncher variant="header" />
          </div>
        </div>
        <Outlet />
      </main>

      {!onChatPage && <AssistantPanel />}
    </div>
  );
}

export function AppLayout({ initialPanel = DEFAULT_PANEL }: { initialPanel?: PanelState }) {
  const { user, loading } = useAuth();

  // Show loading state while checking authentication
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <SpinnerGap size={48} className="animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <SidebarProvider>
      <AssistantProvider initialPanel={initialPanel}>
        <AppLayoutContent />
      </AssistantProvider>
    </SidebarProvider>
  );
}
