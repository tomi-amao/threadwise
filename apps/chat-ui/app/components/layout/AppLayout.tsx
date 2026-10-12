/**
 * App Layout Component
 *
 * Main layout wrapper for authenticated pages.
 * Includes sidebar navigation and main content area.
 */

import React from 'react';
import { Outlet, Navigate, useLocation } from 'react-router';
import { useAuth } from '~/providers/AuthProvider';
import { SidebarProvider, useSidebar } from '~/providers/SidebarProvider';
import { Sidebar } from './Sidebar';
import { SpinnerGap, List } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';

function AppLayoutContent() {
  const { collapsed, setMobileOpen } = useSidebar();
  const location = useLocation();

  // Check if current route is the chat page (which has its own mobile header)
  const isChatPage = location.pathname === '/chat';

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <main
        className={cn(
          'min-h-screen transition-all duration-300 ease-in-out',
          collapsed ? 'lg:ml-[72px]' : 'lg:ml-64'
        )}
      >
        {/* Mobile Header - Only show on non-chat pages since ChatLayout has its own */}
        {!isChatPage && (
          <div className="lg:hidden sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur-sm p-4">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileOpen(true)}
                className="h-8 w-8"
                title="Open navigation menu"
              >
                <List size={20} weight="bold" />
              </Button>
              <h1 className="text-lg font-semibold">ThreadWise</h1>
            </div>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

export function AppLayout() {
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
      <AppLayoutContent />
    </SidebarProvider>
  );
}
