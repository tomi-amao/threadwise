/**
 * Sync Progress Toast Component
 *
 * Non-blocking, persistent toast that shows real-time sync progress.
 * Users can dismiss it, minimize it, or expand it to see full details.
 * Uses Inngest Realtime for live updates.
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  ArrowsClockwise,
  CheckCircle,
  WarningCircle,
  Clock,
  X,
  CaretUp,
  CaretDown,
  Package,
  ShoppingCart,
  Cube,
  FileText,
  Database,
} from 'phosphor-react';
import { useInngestSubscription } from '@inngest/realtime/hooks';
import { cn } from '~/lib/utils';

interface SyncProgressData {
  endpoint: string;
  status: 'starting' | 'syncing' | 'completed' | 'error';
  items_stored: number;
  pages_processed: number;
  total_items: number | null;
  error: string | null;
  timestamp: string;
}

interface SyncStatusData {
  status: 'syncing' | 'completed' | 'error';
  endpoints_completed: number;
  endpoints_total: number;
  total_items: number;
  error: string | null;
  timestamp: string;
}

interface SyncProgressToastProps {
  sourceId: string;
  sourceName: string;
  onClose: () => void;
  onComplete?: () => void;
}

// Status priority for preventing regressions
const STATUS_PRIORITY: Record<string, number> = {
  starting: 0,
  syncing: 1,
  completed: 2,
  error: 2,
};

// Endpoint icons for visual distinction
const endpointIcons: Record<string, React.ReactNode> = {
  products: <Package size={16} weight="duotone" />,
  orders: <ShoppingCart size={16} weight="duotone" />,
  inventory: <Cube size={16} weight="duotone" />,
  store_pages: <FileText size={16} weight="duotone" />,
  transactions: <Database size={16} weight="duotone" />,
  accounts: <Database size={16} weight="duotone" />,
};

// Status indicator component with animated states
function StatusIndicator({ status }: { status: string }) {
  const baseClasses = 'w-2 h-2 rounded-full';

  switch (status) {
    case 'completed':
      return <span className={cn(baseClasses, 'bg-emerald-400')} />;
    case 'error':
      return <span className={cn(baseClasses, 'bg-red-400')} />;
    case 'syncing':
      return <span className={cn(baseClasses, 'bg-blue-400 animate-pulse')} />;
    default:
      return <span className={cn(baseClasses, 'bg-gray-500')} />;
  }
}

function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    // @ts-ignore
    return import.meta.env?.VITE_AI_AGENT_URL || 'http://localhost:8000';
  }
  return process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:8000';
}

export function SyncProgressToast({
  sourceId,
  sourceName,
  onClose,
  onComplete,
}: SyncProgressToastProps) {
  const baseUrl = getApiBaseUrl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [overallStatus, setOverallStatus] = useState<SyncStatusData | null>(null);
  const [endpointProgress, setEndpointProgress] = useState<Map<string, SyncProgressData>>(
    new Map()
  );
  const lastSeenTimestamps = useRef<Map<string, number>>(new Map());
  const hasCalledComplete = useRef(false);

  // Fetch subscription token
  const refreshToken = async () => {
    const response = await fetch(`${baseUrl}/realtime/subscription-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: sourceId,
        topics: ['progress', 'status'],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get subscription token: ${response.statusText}`);
    }
    return response.json();
  };

  // Inngest realtime subscription
  const { error, state, freshData } = useInngestSubscription({
    refreshToken,
    bufferInterval: 100,
  });

  // Process fresh data
  useEffect(() => {
    if (!freshData || freshData.length === 0) return;

    freshData.forEach((message: any) => {
      if (message.topic === 'status') {
        setOverallStatus(prev => {
          const incoming = message.data as SyncStatusData;
          if (!prev) return incoming;

          const incomingTime = new Date(incoming.timestamp).getTime();
          const prevTime = new Date(prev.timestamp).getTime();
          if (incomingTime <= prevTime) return prev;

          return incoming;
        });
      } else if (message.topic === 'progress') {
        const progressData = message.data as SyncProgressData;
        const incomingTime = new Date(progressData.timestamp).getTime();
        const lastSeen = lastSeenTimestamps.current.get(progressData.endpoint) ?? -1;

        if (incomingTime <= lastSeen) return;
        lastSeenTimestamps.current.set(progressData.endpoint, incomingTime);

        setEndpointProgress(prev => {
          const existing = prev.get(progressData.endpoint);

          if (existing) {
            const existingPriority = STATUS_PRIORITY[existing.status] ?? 0;
            const incomingPriority = STATUS_PRIORITY[progressData.status] ?? 0;

            if (incomingPriority < existingPriority) {
              const merged: SyncProgressData = {
                ...existing,
                items_stored: Math.max(existing.items_stored, progressData.items_stored),
                pages_processed: Math.max(existing.pages_processed, progressData.pages_processed),
              };
              const newMap = new Map(prev);
              newMap.set(progressData.endpoint, merged);
              return newMap;
            }

            const merged: SyncProgressData = {
              ...progressData,
              items_stored: Math.max(existing.items_stored, progressData.items_stored),
              pages_processed: Math.max(existing.pages_processed, progressData.pages_processed),
            };
            const newMap = new Map(prev);
            newMap.set(progressData.endpoint, merged);
            return newMap;
          }

          const newMap = new Map(prev);
          newMap.set(progressData.endpoint, progressData);
          return newMap;
        });
      }
    });
  }, [freshData]);

  // Check completion status
  const allEndpointsCompleted = useMemo(() => {
    if (endpointProgress.size === 0) return false;
    return Array.from(endpointProgress.values()).every(p => p.status === 'completed');
  }, [endpointProgress]);

  const isCompleted = overallStatus?.status === 'completed' || allEndpointsCompleted;
  const hasError = overallStatus?.status === 'error' || state === 'error';

  // Calculate totals
  const totalItems = useMemo(() => {
    return Array.from(endpointProgress.values()).reduce((acc, p) => acc + p.items_stored, 0);
  }, [endpointProgress]);

  const completedEndpoints = useMemo(() => {
    return Array.from(endpointProgress.values()).filter(p => p.status === 'completed').length;
  }, [endpointProgress]);

  // Call onComplete when sync finishes
  useEffect(() => {
    if (isCompleted && onComplete && !hasCalledComplete.current) {
      hasCalledComplete.current = true;
      // Delay slightly to show the completion state
      setTimeout(() => {
        onComplete();
      }, 2000);
    }
  }, [isCompleted, onComplete]);

  // Progress percentage
  const progressPercent = overallStatus
    ? (overallStatus.endpoints_completed / overallStatus.endpoints_total) * 100
    : endpointProgress.size > 0
      ? (completedEndpoints / endpointProgress.size) * 100
      : 0;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-50',
        'bg-card border border-border rounded-xl shadow-2xl',
        'overflow-hidden',
        'animate-in slide-in-from-bottom-4 fade-in duration-300',
        isExpanded ? 'w-96' : 'w-80',
        'transition-all'
      )}
    >
      {/* Header - Always visible */}
      <div
        className={cn(
          'flex items-center gap-3 p-3 cursor-pointer select-none',
          'hover:bg-accent/50 transition-colors'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Status icon */}
        <div className="relative">
          {isCompleted ? (
            <CheckCircle size={24} weight="fill" className="text-emerald-400" />
          ) : hasError ? (
            <WarningCircle size={24} weight="fill" className="text-red-400" />
          ) : (
            <ArrowsClockwise size={24} className="text-blue-400 animate-spin" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {isCompleted ? 'Sync Complete' : hasError ? 'Sync Error' : 'Syncing...'}
            </span>
            {sourceName && (
              <span className="text-xs text-muted-foreground truncate">{sourceName}</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground">
              {totalItems.toLocaleString()} items
            </span>
            {!isCompleted && (
              <>
                <span className="text-xs text-muted-foreground">•</span>
                <span className="text-xs text-muted-foreground">
                  {completedEndpoints}/{endpointProgress.size || '?'} endpoints
                </span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={e => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? <CaretDown size={16} /> : <CaretUp size={16} />}
          </button>
          <button
            onClick={e => {
              e.stopPropagation();
              onClose();
            }}
            className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full transition-all duration-300',
            isCompleted ? 'bg-emerald-500' : hasError ? 'bg-red-500' : 'bg-blue-500'
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Error message */}
          {(error || overallStatus?.error) && (
            <div className="mx-3 mt-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-xs text-red-400">{error?.message || overallStatus?.error}</p>
            </div>
          )}

          {/* Endpoints list */}
          <div className="p-3 space-y-2 max-h-64 overflow-y-auto">
            {endpointProgress.size === 0 ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock size={14} />
                <span className="text-xs">Initializing sync...</span>
              </div>
            ) : (
              Array.from(endpointProgress.entries()).map(([endpoint, progress]) => (
                <EndpointProgressCard key={endpoint} endpoint={endpoint} progress={progress} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Individual endpoint progress card
function EndpointProgressCard({
  endpoint,
  progress,
}: {
  endpoint: string;
  progress: SyncProgressData;
}) {
  const icon = endpointIcons[endpoint] || <Database size={16} weight="duotone" />;
  const isActive = progress.status === 'syncing' || progress.status === 'starting';

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-2.5 rounded-lg transition-all duration-200',
        'bg-muted/50 animate-in fade-in slide-in-from-bottom-2',
        isActive && 'ring-1 ring-blue-500/30 bg-blue-500/5'
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          'flex items-center justify-center w-8 h-8 rounded-lg',
          progress.status === 'completed'
            ? 'bg-emerald-500/10 text-emerald-400'
            : progress.status === 'error'
              ? 'bg-red-500/10 text-red-400'
              : 'bg-blue-500/10 text-blue-400'
        )}
      >
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground capitalize">{endpoint}</span>
          <StatusIndicator status={progress.status} />
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {progress.items_stored.toLocaleString()} items
          </span>
          {progress.pages_processed > 0 && (
            <span className="text-xs text-muted-foreground">
              {progress.pages_processed} {progress.pages_processed === 1 ? 'page' : 'pages'}
            </span>
          )}
        </div>
        {progress.error && <p className="text-xs text-red-400 mt-1 truncate">{progress.error}</p>}
      </div>

      {/* Status icon */}
      <div className="shrink-0">
        {progress.status === 'completed' && (
          <CheckCircle size={18} weight="fill" className="text-emerald-400" />
        )}
        {progress.status === 'error' && (
          <WarningCircle size={18} weight="fill" className="text-red-400" />
        )}
        {(progress.status === 'syncing' || progress.status === 'starting') && (
          <ArrowsClockwise size={18} className="text-blue-400 animate-spin" />
        )}
      </div>
    </div>
  );
}
