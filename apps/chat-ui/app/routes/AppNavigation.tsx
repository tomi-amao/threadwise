import React from 'react';
import { ChartLine, ChatCircle } from 'phosphor-react';
import { Button } from '~/components/ui/button';

interface AppNavigationProps {
  activeView: 'dashboard' | 'chat';
  onViewChange: (view: 'dashboard' | 'chat') => void;
}

/**
 * AppNavigation Component
 *
 * Provides top-level navigation between Dashboard and Chat views.
 * Designed to be minimal and out of the way while providing clear navigation.
 */
export function AppNavigation({ activeView, onViewChange }: AppNavigationProps) {
  return (
    <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 md:top-4 md:bottom-auto md:left-auto md:right-4 md:translate-x-0">
      <div className="flex items-center gap-1 rounded-full border border-border bg-card/95 backdrop-blur-md p-1 shadow-lg">
        <Button
          variant={activeView === 'dashboard' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewChange('dashboard')}
          className="rounded-full gap-2 px-4"
        >
          <ChartLine size={18} weight={activeView === 'dashboard' ? 'fill' : 'regular'} />
          <span className="hidden sm:inline">Dashboard</span>
        </Button>

        <Button
          variant={activeView === 'chat' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewChange('chat')}
          className="rounded-full gap-2 px-4"
        >
          <ChatCircle size={18} weight={activeView === 'chat' ? 'fill' : 'regular'} />
          <span className="hidden sm:inline">Ask AI</span>
        </Button>
      </div>
    </nav>
  );
}
