import React from 'react';
import { ChartLine, ArrowClockwise, Calendar, CaretDown, CircleNotch } from 'phosphor-react';
import { Button } from '~/components/ui/button';

interface DashboardHeaderProps {
  onRefresh?: () => void;
  lastUpdated?: Date;
  entityName?: string;
  isLoading?: boolean;
}

export function DashboardHeader({
  onRefresh,
  lastUpdated,
  entityName,
  isLoading,
}: DashboardHeaderProps) {
  return (
    <header className="border-b border-border bg-card/95 backdrop-blur-sm sticky top-0 z-40">
      <div className="px-4 md:px-6 lg:px-8 py-4">
        <div className="flex items-center justify-between gap-4 min-h-[64px]">
          {/* Logo and Title */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
              <ChartLine size={24} className="text-primary" weight="duotone" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-foreground truncate">
                {entityName || 'ThreadWise'}
              </h1>
              <p className="text-xs text-muted-foreground">Business Intelligence Dashboard</p>
            </div>
          </div>

          {/* Center: Period Selector */}
          <div className="hidden lg:flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" className="gap-2">
              <Calendar size={16} />
              All Time
              <CaretDown size={14} />
            </Button>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {lastUpdated && (
              <span className="hidden sm:block text-xs text-muted-foreground whitespace-nowrap">
                {isLoading ? 'Refreshing...' : `Updated ${lastUpdated.toLocaleTimeString()}`}
              </span>
            )}

            <Button
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              className="h-9 w-9 flex-shrink-0"
              title="Refresh data"
              disabled={isLoading}
            >
              {isLoading ? (
                <CircleNotch size={18} className="animate-spin" />
              ) : (
                <ArrowClockwise size={18} />
              )}
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
