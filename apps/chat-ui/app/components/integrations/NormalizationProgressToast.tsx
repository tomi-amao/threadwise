/**
 * Normalization Progress Toast Component
 *
 * Non-blocking, persistent toast that shows real-time normalization progress.
 * Users can dismiss it, minimize it, or expand it to see full details.
 * Uses Inngest Realtime for live updates.
 *
 * Shows progress per entity type (profile → product → inventory_item → order)
 * with counts of events processed, succeeded, and failed.
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
  UserCircle,
  Package,
  Cube,
  ShoppingCart,
  Database,
  Bank,
  CurrencyCircleDollar,
  Receipt,
} from 'phosphor-react';
import { useInngestSubscription } from '@inngest/realtime/hooks';
import { cn } from '~/lib/utils';

// =============================================================================
// TYPES (mirror backend NormalizationProgressData / NormalizationStatusData)
// =============================================================================

interface NormalizationProgressData {
  entity_type: string;
  status: 'processing' | 'completed' | 'error';
  events_processed: number;
  events_total: number;
  events_succeeded: number;
  events_failed: number;
  error: string | null;
  timestamp: string;
}

interface NormalizationStatusData {
  status: 'normalizing' | 'completed' | 'error';
  mode: 'hard' | 'soft';
  entity_types_completed: number;
  entity_types_total: number;
  total_processed: number;
  total_succeeded: number;
  total_failed: number;
  error: string | null;
  timestamp: string;
}

interface NormalizationProgressToastProps {
  sourceId: string;
  sourceName: string;
  mode: 'hard' | 'soft';
  onClose: () => void;
  onComplete?: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// Status priority for preventing regressions
const STATUS_PRIORITY: Record<string, number> = {
  processing: 0,
  completed: 1,
  error: 1,
};

// Entity type icons
const entityTypeIcons: Record<string, React.ReactNode> = {
  profile: <UserCircle size={16} weight="duotone" />,
  product: <Package size={16} weight="duotone" />,
  inventory_item: <Cube size={16} weight="duotone" />,
  order: <ShoppingCart size={16} weight="duotone" />,
  transaction: <CurrencyCircleDollar size={16} weight="duotone" />,
  bank_account: <Bank size={16} weight="duotone" />,
  financial_transaction: <CurrencyCircleDollar size={16} weight="duotone" />,
  expense: <Receipt size={16} weight="duotone" />,
};

// Friendly entity type labels
const entityTypeLabels: Record<string, string> = {
  profile: 'Profiles',
  product: 'Products',
  inventory_item: 'Inventory',
  order: 'Orders',
  transaction: 'Transactions',
  bank_account: 'Bank Accounts',
  financial_transaction: 'Financial Transactions',
  expense: 'Expenses',
};

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function StatusIndicator({ status }: { status: string }) {
  const baseClasses = 'w-2 h-2 rounded-full';

  switch (status) {
    case 'completed':
      return <span className={cn(baseClasses, 'bg-emerald-400')} />;
    case 'error':
      return <span className={cn(baseClasses, 'bg-red-400')} />;
    case 'processing':
      return <span className={cn(baseClasses, 'bg-purple-400 animate-pulse')} />;
    default:
      return <span className={cn(baseClasses, 'bg-gray-500')} />;
  }
}

function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    // @ts-ignore
    return import.meta.env?.VITE_AI_AGENT_URL || 'http://localhost:2024';
  }
  return process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:2024';
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function NormalizationProgressToast({
  sourceId,
  sourceName,
  mode,
  onClose,
  onComplete,
}: NormalizationProgressToastProps) {
  const baseUrl = getApiBaseUrl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [overallStatus, setOverallStatus] = useState<NormalizationStatusData | null>(null);
  const [entityProgress, setEntityProgress] = useState<Map<string, NormalizationProgressData>>(
    new Map()
  );
  const lastSeenTimestamps = useRef<Map<string, number>>(new Map());
  const hasCalledComplete = useRef(false);

  // Fetch subscription token for normalization channel
  const refreshToken = async () => {
    const response = await fetch(`${baseUrl}/realtime/subscription-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: sourceId,
        channel_type: 'normalization',
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
          const incoming = message.data as NormalizationStatusData;
          if (!prev) return incoming;

          const incomingTime = new Date(incoming.timestamp).getTime();
          const prevTime = new Date(prev.timestamp).getTime();
          if (incomingTime <= prevTime) return prev;

          return incoming;
        });
      } else if (message.topic === 'progress') {
        const progressData = message.data as NormalizationProgressData;
        const incomingTime = new Date(progressData.timestamp).getTime();
        const lastSeen = lastSeenTimestamps.current.get(progressData.entity_type) ?? -1;

        if (incomingTime <= lastSeen) return;
        lastSeenTimestamps.current.set(progressData.entity_type, incomingTime);

        setEntityProgress(prev => {
          const existing = prev.get(progressData.entity_type);

          if (existing) {
            const existingPriority = STATUS_PRIORITY[existing.status] ?? 0;
            const incomingPriority = STATUS_PRIORITY[progressData.status] ?? 0;

            // Don't regress status
            if (incomingPriority < existingPriority) {
              const merged: NormalizationProgressData = {
                ...existing,
                events_processed: Math.max(
                  existing.events_processed,
                  progressData.events_processed
                ),
                events_total: Math.max(existing.events_total, progressData.events_total),
                events_succeeded: Math.max(
                  existing.events_succeeded,
                  progressData.events_succeeded
                ),
                events_failed: Math.max(existing.events_failed, progressData.events_failed),
              };
              const newMap = new Map(prev);
              newMap.set(progressData.entity_type, merged);
              return newMap;
            }

            const merged: NormalizationProgressData = {
              ...progressData,
              events_processed: Math.max(existing.events_processed, progressData.events_processed),
              events_total: Math.max(existing.events_total, progressData.events_total),
              events_succeeded: Math.max(existing.events_succeeded, progressData.events_succeeded),
              events_failed: Math.max(existing.events_failed, progressData.events_failed),
            };
            const newMap = new Map(prev);
            newMap.set(progressData.entity_type, merged);
            return newMap;
          }

          const newMap = new Map(prev);
          newMap.set(progressData.entity_type, progressData);
          return newMap;
        });
      }
    });
  }, [freshData]);

  // Computed state
  const allEntityTypesCompleted = useMemo(() => {
    if (entityProgress.size === 0) return false;
    return Array.from(entityProgress.values()).every(p => p.status === 'completed');
  }, [entityProgress]);

  const isCompleted = overallStatus?.status === 'completed' || allEntityTypesCompleted;
  const hasError = overallStatus?.status === 'error' || state === 'error';

  const totalProcessed = useMemo(() => {
    return Array.from(entityProgress.values()).reduce((acc, p) => acc + p.events_processed, 0);
  }, [entityProgress]);

  const totalSucceeded = useMemo(() => {
    return Array.from(entityProgress.values()).reduce((acc, p) => acc + p.events_succeeded, 0);
  }, [entityProgress]);

  const totalFailed = useMemo(() => {
    return Array.from(entityProgress.values()).reduce((acc, p) => acc + p.events_failed, 0);
  }, [entityProgress]);

  const completedEntityTypes = useMemo(() => {
    return Array.from(entityProgress.values()).filter(p => p.status === 'completed').length;
  }, [entityProgress]);

  // Call onComplete when normalization finishes
  useEffect(() => {
    if (isCompleted && onComplete && !hasCalledComplete.current) {
      hasCalledComplete.current = true;
      setTimeout(() => {
        onComplete();
      }, 2000);
    }
  }, [isCompleted, onComplete]);

  // Progress percentage
  const progressPercent = overallStatus
    ? (overallStatus.entity_types_completed / overallStatus.entity_types_total) * 100
    : entityProgress.size > 0
      ? (completedEntityTypes / entityProgress.size) * 100
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
            <Database size={24} className="text-purple-400 animate-pulse" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {isCompleted ? 'Data Loaded' : hasError ? 'Loading Error' : 'Loading Data...'}
            </span>
            <span
              className={cn(
                'text-[10px] font-medium px-1.5 py-0.5 rounded-full uppercase',
                mode === 'hard'
                  ? 'bg-orange-500/10 text-orange-400'
                  : 'bg-blue-500/10 text-blue-400'
              )}
            >
              {mode}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {sourceName && (
              <span className="text-xs text-muted-foreground truncate">{sourceName}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {totalSucceeded.toLocaleString()} processed
              {totalFailed > 0 && <span className="text-red-400"> · {totalFailed} failed</span>}
            </span>
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
            isCompleted ? 'bg-emerald-500' : hasError ? 'bg-red-500' : 'bg-purple-500'
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

          {/* Entity type list */}
          <div className="p-3 space-y-2 max-h-64 overflow-y-auto">
            {entityProgress.size === 0 ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock size={14} />
                <span className="text-xs">Initializing normalization...</span>
              </div>
            ) : (
              Array.from(entityProgress.entries())
                .filter(
                  ([_, progress]) => progress.events_total > 0 || progress.status === 'processing'
                )
                .map(([entityType, progress]) => (
                  <EntityTypeProgressCard
                    key={entityType}
                    entityType={entityType}
                    progress={progress}
                  />
                ))
            )}
          </div>

          {/* Summary footer */}
          {entityProgress.size > 0 && (
            <div className="px-3 pb-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border pt-2">
                <span>
                  {completedEntityTypes}/{entityProgress.size} entity types
                </span>
                <span>
                  {totalProcessed} processed · {totalSucceeded} ok · {totalFailed} failed
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ENTITY TYPE PROGRESS CARD
// =============================================================================

function EntityTypeProgressCard({
  entityType,
  progress,
}: {
  entityType: string;
  progress: NormalizationProgressData;
}) {
  const icon = entityTypeIcons[entityType] || <Database size={16} weight="duotone" />;
  const label = entityTypeLabels[entityType] || entityType;
  const isActive = progress.status === 'processing';

  // Per-entity progress bar
  const entityPercent =
    progress.events_total > 0 ? (progress.events_processed / progress.events_total) * 100 : 0;

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-2.5 rounded-lg transition-all duration-200',
        'bg-muted/50 animate-in fade-in slide-in-from-bottom-2',
        isActive && 'ring-1 ring-purple-500/30 bg-purple-500/5'
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
              : 'bg-purple-500/10 text-purple-400'
        )}
      >
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <StatusIndicator status={progress.status} />
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {progress.events_succeeded}/{progress.events_total} events
          </span>
          {progress.events_failed > 0 && (
            <span className="text-xs text-red-400">{progress.events_failed} failed</span>
          )}
        </div>
        {/* Mini progress bar */}
        {isActive && progress.events_total > 0 && (
          <div className="h-0.5 bg-muted rounded-full mt-1.5 overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-300"
              style={{ width: `${entityPercent}%` }}
            />
          </div>
        )}
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
        {progress.status === 'processing' && (
          <ArrowsClockwise size={18} className="text-purple-400 animate-spin" />
        )}
      </div>
    </div>
  );
}
