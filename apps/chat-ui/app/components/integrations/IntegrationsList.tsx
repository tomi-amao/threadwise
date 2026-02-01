/**
 * Integrations List Component
 *
 * Displays a list of connected integrations with their sync status
 * and provides controls to trigger manual syncs.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ArrowsClockwise,
  Check,
  Warning,
  Clock,
  PlugsConnected,
  CaretRight,
  Storefront,
} from 'phosphor-react';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';
import {
  getIntegrationsSummary,
  triggerSync,
  type IntegrationSummary,
} from '~/lib/api/integrations';

interface IntegrationsListProps {
  collapsed?: boolean;
  onClose?: () => void;
}

// Provider icons mapping
const providerIcons: Record<string, React.ReactNode> = {
  squarespace: <Storefront size={18} weight="duotone" className="text-orange-400" />,
  revolut: <PlugsConnected size={18} weight="duotone" className="text-blue-400" />,
  default: <PlugsConnected size={18} weight="duotone" className="text-gray-400" />,
};

// Status badge styles
const statusStyles: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  idle: {
    bg: 'bg-gray-500/20',
    text: 'text-gray-400',
    icon: <Clock size={12} weight="bold" />,
  },
  syncing: {
    bg: 'bg-blue-500/20',
    text: 'text-blue-400',
    icon: <ArrowsClockwise size={12} weight="bold" className="animate-spin" />,
  },
  completed: {
    bg: 'bg-green-500/20',
    text: 'text-green-400',
    icon: <Check size={12} weight="bold" />,
  },
  error: {
    bg: 'bg-red-500/20',
    text: 'text-red-400',
    icon: <Warning size={12} weight="bold" />,
  },
};

function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] || statusStyles.idle;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
        style.bg,
        style.text
      )}
    >
      {style.icon}
      <span className="capitalize">{status}</span>
    </span>
  );
}

function IntegrationCard({
  integration,
  onSync,
  isSyncing,
}: {
  integration: IntegrationSummary;
  onSync: () => void;
  isSyncing: boolean;
}) {
  const icon = providerIcons[integration.provider] || providerIcons.default;

  // Format last synced date
  const formatLastSynced = (dateStr: string | null) => {
    if (!dateStr) return 'Never synced';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  // Calculate total items from stats
  const totalItems = integration.stats
    ? Object.values(integration.stats).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className="p-3 rounded-lg bg-sidebar-accent/30 hover:bg-sidebar-accent/50 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <div className="min-w-0">
            <p className="text-sm font-medium text-sidebar-foreground truncate">
              {integration.display_name || integration.provider}
            </p>
            <p className="text-xs text-sidebar-foreground/50 truncate">
              {integration.entity_name || integration.external_account_id}
            </p>
          </div>
        </div>
        <StatusBadge status={integration.sync_status} />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div className="text-xs text-sidebar-foreground/60">
          {integration.sync_error ? (
            <span className="text-red-400" title={integration.sync_error}>
              Error: {integration.sync_error.slice(0, 30)}...
            </span>
          ) : (
            <>
              <span>{formatLastSynced(integration.last_synced_at)}</span>
              {totalItems > 0 && (
                <span className="ml-2 text-sidebar-foreground/40">
                  • {totalItems.toLocaleString()} items
                </span>
              )}
            </>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onSync}
          disabled={isSyncing || integration.sync_status === 'syncing'}
          className="h-7 px-2 text-xs"
        >
          <ArrowsClockwise
            size={14}
            weight="bold"
            className={cn(
              'mr-1',
              (isSyncing || integration.sync_status === 'syncing') && 'animate-spin'
            )}
          />
          Sync
        </Button>
      </div>

      {/* Stats breakdown */}
      {integration.stats && Object.keys(integration.stats).length > 0 && (
        <div className="mt-2 pt-2 border-t border-sidebar-border/30">
          <div className="flex flex-wrap gap-2">
            {Object.entries(integration.stats).map(([type, count]) => (
              <span
                key={type}
                className="inline-flex items-center px-1.5 py-0.5 rounded bg-sidebar-accent/50 text-xs text-sidebar-foreground/70"
              >
                {type}: {count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function IntegrationsList({ collapsed, onClose }: IntegrationsListProps) {
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [isOpen, setIsOpen] = useState(false);

  // Fetch integrations
  const fetchIntegrations = useCallback(async () => {
    try {
      const data = await getIntegrationsSummary();
      setIntegrations(data);
    } catch (error) {
      console.error('Failed to fetch integrations:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchIntegrations();
      // Poll for updates while open
      const interval = setInterval(fetchIntegrations, 10000);
      return () => clearInterval(interval);
    }
  }, [isOpen, fetchIntegrations]);

  // Handle sync trigger
  const handleSync = async (sourceId: string) => {
    setSyncingIds(prev => new Set([...prev, sourceId]));

    try {
      await triggerSync(sourceId);
      // Refresh list after triggering
      await fetchIntegrations();
    } catch (error) {
      console.error('Failed to trigger sync:', error);
    } finally {
      setSyncingIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  // Toggle panel
  const toggleOpen = () => {
    setIsOpen(prev => !prev);
    if (!isOpen) {
      setLoading(true);
    }
  };

  // Collapsed view - just a button
  if (collapsed) {
    return (
      <button
        onClick={toggleOpen}
        title="Integrations"
        className={cn(
          'w-full flex items-center justify-center rounded-xl text-sm font-medium transition-all duration-200',
          'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'px-3 py-3'
        )}
      >
        <PlugsConnected size={20} weight="duotone" />
      </button>
    );
  }

  return (
    <div className="space-y-2">
      {/* Toggle Button */}
      <button
        onClick={toggleOpen}
        className={cn(
          'w-full flex items-center justify-between rounded-xl text-sm font-medium transition-all duration-200',
          'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'px-4 py-3'
        )}
      >
        <div className="flex items-center gap-3">
          <PlugsConnected size={20} weight="duotone" />
          <span>Integrations</span>
        </div>
        <div className="flex items-center gap-2">
          {integrations.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-sidebar-primary/20 text-sidebar-primary text-xs">
              {integrations.length}
            </span>
          )}
          <CaretRight
            size={14}
            weight="bold"
            className={cn('transition-transform', isOpen && 'rotate-90')}
          />
        </div>
      </button>

      {/* Expandable Panel */}
      {isOpen && (
        <div className="space-y-2 pl-2 pr-1">
          {loading ? (
            <div className="p-4 text-center">
              <ArrowsClockwise
                size={20}
                weight="bold"
                className="animate-spin mx-auto text-sidebar-foreground/50"
              />
              <p className="text-xs text-sidebar-foreground/50 mt-2">Loading...</p>
            </div>
          ) : integrations.length === 0 ? (
            <div className="p-4 text-center">
              <PlugsConnected
                size={24}
                weight="duotone"
                className="mx-auto text-sidebar-foreground/30"
              />
              <p className="text-xs text-sidebar-foreground/50 mt-2">No integrations connected</p>
              <p className="text-xs text-sidebar-foreground/40 mt-1">
                Add a Squarespace or Revolut connection to get started
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {integrations.map(integration => (
                <IntegrationCard
                  key={integration.id}
                  integration={integration}
                  onSync={() => handleSync(integration.id)}
                  isSyncing={syncingIds.has(integration.id)}
                />
              ))}
            </div>
          )}

          {/* Sync All Button */}
          {integrations.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => integrations.forEach(i => handleSync(i.id))}
              disabled={syncingIds.size > 0}
              className="w-full mt-2 text-xs"
            >
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={cn('mr-1', syncingIds.size > 0 && 'animate-spin')}
              />
              Sync All Integrations
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default IntegrationsList;
