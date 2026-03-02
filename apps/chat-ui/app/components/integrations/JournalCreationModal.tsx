/**
 * Journal Creation Modal
 *
 * Provides one-click journal creation from canonical financial data.
 * Three journal types available:
 * - Accrue Orders: Revenue recognition from completed orders
 * - Settle Payouts: Settlement from reconciled bank payouts
 * - Journal Expenses: Expense recording from categorized bank transactions
 *
 * Each action auto-discovers eligible records and creates journals in batch.
 */

import React, { useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  X,
  BookOpen,
  ShoppingCart,
  Bank,
  Receipt,
  ArrowsClockwise,
  CheckCircle,
  WarningCircle,
  Play,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import {
  accrueOrders,
  settleMatches,
  journalExpenses,
  type BatchJournalResult,
} from '~/lib/api/accounting';

// =============================================================================
// TYPES
// =============================================================================

interface JournalCreationModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityId: string;
  providerName: string;
}

type JournalAction = 'accrue' | 'settle' | 'expense';

interface ActionState {
  loading: boolean;
  result: BatchJournalResult | null;
  error: string | null;
}

const INITIAL_ACTION_STATE: ActionState = {
  loading: false,
  result: null,
  error: null,
};

// =============================================================================
// ACTION CARDS CONFIG
// =============================================================================

const JOURNAL_ACTIONS: Array<{
  key: JournalAction;
  title: string;
  description: string;
  detailLines: string[];
  icon: React.ElementType;
  iconColor: string;
  bgColor: string;
}> = [
  {
    key: 'accrue',
    title: 'Accrue Orders',
    description: 'Create revenue recognition journals from completed orders.',
    detailLines: ['DR 1200 Payment Gateway Clearing', 'CR 4000 Revenue / 4100 Shipping / 2100 Tax'],
    icon: ShoppingCart,
    iconColor: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
  },
  {
    key: 'settle',
    title: 'Settle Payouts',
    description: 'Create settlement journals from reconciled bank payouts.',
    detailLines: ['DR 1000/1100 Cash + 5000 Processing Fees', 'CR 1200 Payment Gateway Clearing'],
    icon: Bank,
    iconColor: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
  },
  {
    key: 'expense',
    title: 'Journal Expenses',
    description: 'Create expense journals from categorized bank transactions.',
    detailLines: ['DR 6xxx Expense Account', 'CR 1000/1100 Cash'],
    icon: Receipt,
    iconColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
  },
];

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function JournalCreationModal({
  isOpen,
  onClose,
  entityId,
  providerName,
}: JournalCreationModalProps) {
  const [actionStates, setActionStates] = useState<Record<JournalAction, ActionState>>({
    accrue: { ...INITIAL_ACTION_STATE },
    settle: { ...INITIAL_ACTION_STATE },
    expense: { ...INITIAL_ACTION_STATE },
  });

  const updateActionState = useCallback((action: JournalAction, update: Partial<ActionState>) => {
    setActionStates(prev => ({
      ...prev,
      [action]: { ...prev[action], ...update },
    }));
  }, []);

  const handleRunAction = useCallback(
    async (action: JournalAction) => {
      updateActionState(action, { loading: true, error: null, result: null });
      try {
        let result: BatchJournalResult;
        switch (action) {
          case 'accrue':
            result = await accrueOrders(entityId);
            break;
          case 'settle':
            result = await settleMatches(entityId);
            break;
          case 'expense':
            result = await journalExpenses(entityId);
            break;
        }
        updateActionState(action, { loading: false, result });
        const total = result.created + result.skipped;
        if (result.created > 0) {
          toast.success(
            `Created ${result.created} journal${result.created !== 1 ? 's' : ''}${result.skipped > 0 ? ` (${result.skipped} skipped)` : ''}`
          );
        } else if (total === 0) {
          toast.info('No eligible records found to journal');
        } else {
          toast.info(`All ${result.skipped} eligible records already journaled`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        updateActionState(action, { loading: false, error: message });
        toast.error(`Failed: ${message}`);
      }
    },
    [entityId, updateActionState]
  );

  const handleRunAll = useCallback(async () => {
    for (const action of JOURNAL_ACTIONS) {
      await handleRunAction(action.key);
    }
  }, [handleRunAction]);

  const anyLoading = Object.values(actionStates).some(s => s.loading);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-700/50 bg-zinc-900/95 backdrop-blur-sm px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
              <BookOpen size={22} weight="duotone" className="text-violet-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Create Journals</h2>
              <p className="text-sm text-zinc-400">
                {providerName} &mdash; Double-entry journal creation
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            <X size={20} weight="bold" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {/* Run All Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleRunAll}
              disabled={anyLoading}
              className={cn(
                'gap-2 text-sm font-medium',
                'bg-violet-600 hover:bg-violet-500 text-white',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {anyLoading ? (
                <ArrowsClockwise size={16} className="animate-spin" />
              ) : (
                <Play size={16} weight="fill" />
              )}
              Run All
            </Button>
          </div>

          {/* Action Cards */}
          {JOURNAL_ACTIONS.map(action => {
            const state = actionStates[action.key];
            const Icon = action.icon;

            return (
              <div
                key={action.key}
                className="rounded-xl border border-zinc-700/50 bg-zinc-800/50 p-5 transition-colors hover:border-zinc-600/50"
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left: Icon + Info */}
                  <div className="flex items-start gap-4 flex-1">
                    <div
                      className={cn(
                        'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
                        action.bgColor
                      )}
                    >
                      <Icon size={22} weight="duotone" className={action.iconColor} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold text-zinc-100">{action.title}</h3>
                      <p className="mt-1 text-sm text-zinc-400">{action.description}</p>
                      <div className="mt-2 space-y-0.5">
                        {action.detailLines.map((line, i) => (
                          <p key={i} className="text-xs font-mono text-zinc-500">
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right: Run Button */}
                  <Button
                    onClick={() => handleRunAction(action.key)}
                    disabled={state.loading || anyLoading}
                    size="sm"
                    className={cn(
                      'gap-1.5 shrink-0',
                      'bg-zinc-700 hover:bg-zinc-600 text-zinc-200',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    {state.loading ? (
                      <ArrowsClockwise size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} weight="fill" />
                    )}
                    Run
                  </Button>
                </div>

                {/* Result */}
                {state.result && (
                  <div className="mt-4 rounded-lg border border-zinc-700/30 bg-zinc-900/50 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle
                        size={18}
                        weight="fill"
                        className={state.result.created > 0 ? 'text-emerald-400' : 'text-zinc-500'}
                      />
                      <span className="text-sm text-zinc-300">
                        <span className="font-semibold text-zinc-100">{state.result.created}</span>{' '}
                        created
                        {state.result.skipped > 0 && (
                          <>
                            {' · '}
                            <span className="font-semibold text-zinc-100">
                              {state.result.skipped}
                            </span>{' '}
                            skipped
                          </>
                        )}
                      </span>
                    </div>
                    {state.result.errors.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {state.result.errors.slice(0, 3).map((err, i) => (
                          <p key={i} className="text-xs text-red-400 flex items-start gap-1.5">
                            <WarningCircle size={14} className="shrink-0 mt-0.5" />
                            {err}
                          </p>
                        ))}
                        {state.result.errors.length > 3 && (
                          <p className="text-xs text-zinc-500">
                            +{state.result.errors.length - 3} more errors
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Error */}
                {state.error && (
                  <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                    <p className="text-sm text-red-400 flex items-start gap-2">
                      <WarningCircle size={16} className="shrink-0 mt-0.5" />
                      {state.error}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
