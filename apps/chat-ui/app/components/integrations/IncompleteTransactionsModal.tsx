/**
 * Incomplete Transactions Modal
 *
 * Allows users to review and categorise financial transactions that were
 * classified as "other" during normalisation. Shows transactions as a
 * scrollable list with inline category assignment and AI-powered
 * auto-categorisation.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  X,
  Sparkle,
  Check,
  ArrowsClockwise,
  Warning,
  MagnifyingGlass,
  FunnelSimple,
  CaretDown,
  ArrowUp,
  ArrowDown,
  CheckCircle,
  Lightbulb,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import {
  getIncompleteTransactions,
  updateTransactionCategory,
  aiCategorizeTransactions,
  getChartOfAccounts,
  type IncompleteTransaction,
  type ChartOfAccountsEntry,
  type AISuggestion,
} from '~/lib/api/integrations';

// =============================================================================
// TYPES
// =============================================================================

interface IncompleteTransactionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityId?: string;
  sourceId?: string;
  onUpdate?: () => void;
}

type AccountTypeFilter = 'all' | 'expense' | 'asset' | 'liability' | 'revenue' | 'cogs' | 'equity';

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Individual transaction row with inline category assignment */
function TransactionRow({
  transaction,
  chartOfAccounts,
  suggestion,
  onCategorize,
  isSaving,
}: {
  transaction: IncompleteTransaction;
  chartOfAccounts: ChartOfAccountsEntry[];
  suggestion?: AISuggestion;
  onCategorize: (txnId: string, accountNumber: string) => void;
  isSaving: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<AccountTypeFilter>('all');

  const filteredAccounts = useMemo(() => {
    return chartOfAccounts.filter(coa => {
      if (coa.is_header) return false;
      if (typeFilter !== 'all' && coa.account_type !== typeFilter) return false;
      if (search) {
        const term = search.toLowerCase();
        return (
          coa.name.toLowerCase().includes(term) || coa.account_number.toLowerCase().includes(term)
        );
      }
      return true;
    });
  }, [chartOfAccounts, search, typeFilter]);

  const suggestedAccount = suggestion
    ? chartOfAccounts.find(c => c.account_number === suggestion.suggested_account_number)
    : null;

  const isOutgoing = transaction.direction === 'out';
  const formattedAmount = `${isOutgoing ? '-' : '+'}${transaction.currency_code} ${Number(transaction.amount).toFixed(2)}`;

  return (
    <div
      className={cn(
        'border border-border rounded-xl overflow-hidden transition-all duration-200',
        isExpanded ? 'bg-muted/30 ring-1 ring-primary/20' : 'bg-card hover:bg-muted/20'
      )}
    >
      {/* Transaction summary row */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-3 p-3 text-left"
      >
        {/* Direction indicator */}
        <div
          className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            isOutgoing ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
          )}
        >
          {isOutgoing ? <ArrowUp size={16} weight="bold" /> : <ArrowDown size={16} weight="bold" />}
        </div>

        {/* Description & counterparty */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {transaction.counterparty_name || transaction.description || 'Unknown transaction'}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {new Date(transaction.occurred_at).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            {transaction.description && transaction.counterparty_name
              ? ` · ${transaction.description}`
              : ''}
          </p>
        </div>

        {/* AI suggestion badge */}
        {suggestion && !isExpanded && (
          <div
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium shrink-0',
              suggestion.confidence >= 0.7
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-yellow-500/10 text-yellow-400'
            )}
          >
            <Sparkle size={10} weight="fill" />
            {Math.round(suggestion.confidence * 100)}%
          </div>
        )}

        {/* Amount */}
        <span
          className={cn(
            'text-sm font-semibold tabular-nums shrink-0',
            isOutgoing ? 'text-red-400' : 'text-emerald-400'
          )}
        >
          {formattedAmount}
        </span>

        {/* Expand indicator */}
        <CaretDown
          size={14}
          className={cn(
            'text-muted-foreground shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {/* Expanded content — category assignment */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Transaction details grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs bg-muted/50 rounded-lg p-2.5">
            <div>
              <span className="text-muted-foreground">Type</span>
              <p className="text-foreground font-medium capitalize">
                {transaction.transaction_type}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Source</span>
              <p className="text-foreground font-medium capitalize">{transaction.source}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Currency</span>
              <p className="text-foreground font-medium">{transaction.currency_code}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Direction</span>
              <p className="text-foreground font-medium capitalize">{transaction.direction}</p>
            </div>
          </div>

          {/* AI suggestion banner */}
          {suggestion && suggestedAccount && (
            <button
              onClick={() =>
                suggestion.suggested_account_number &&
                onCategorize(transaction.id, suggestion.suggested_account_number)
              }
              disabled={isSaving}
              className={cn(
                'w-full flex items-center gap-3 p-2.5 rounded-lg border text-left transition-all',
                'hover:ring-1 hover:ring-primary/30',
                suggestion.confidence >= 0.7
                  ? 'bg-emerald-500/5 border-emerald-500/20 hover:bg-emerald-500/10'
                  : 'bg-yellow-500/5 border-yellow-500/20 hover:bg-yellow-500/10'
              )}
            >
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                <Lightbulb size={14} weight="fill" className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground">
                  AI suggests: {suggestedAccount.account_number} – {suggestedAccount.name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {Math.round(suggestion.confidence * 100)}% confidence
                  {suggestion.reasoning ? ` · ${suggestion.reasoning}` : ''}
                </p>
              </div>
              <span className="text-[10px] font-medium text-primary shrink-0">Apply</span>
            </button>
          )}

          {/* Search & filter bar */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <MagnifyingGlass
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                placeholder="Search accounts..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full h-8 pl-8 pr-3 text-xs bg-muted/50 border border-border rounded-lg
                           text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="flex items-center gap-1">
              <FunnelSimple size={12} className="text-muted-foreground" />
              <select
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value as AccountTypeFilter)}
                className="h-8 text-xs bg-muted/50 border border-border rounded-lg px-2
                           text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
              >
                <option value="all">All types</option>
                <option value="expense">Expense</option>
                <option value="revenue">Revenue</option>
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
                <option value="cogs">COGS</option>
                <option value="equity">Equity</option>
              </select>
            </div>
          </div>

          {/* Account list */}
          <div className="grid grid-cols-1 gap-1 max-h-40 overflow-y-auto pr-1">
            {filteredAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No matching accounts found
              </p>
            ) : (
              filteredAccounts.map(coa => (
                <button
                  key={coa.id}
                  onClick={() => onCategorize(transaction.id, coa.account_number)}
                  disabled={isSaving}
                  className={cn(
                    'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs',
                    'transition-all duration-100',
                    'bg-muted/20 border border-transparent',
                    'hover:bg-primary/5 hover:border-primary/20 hover:text-foreground',
                    'text-muted-foreground',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10px] text-muted-foreground w-10 shrink-0">
                      {coa.account_number}
                    </span>
                    <span className="truncate">{coa.name}</span>
                  </div>
                  <span className="text-[10px] uppercase text-muted-foreground/60 shrink-0 ml-2">
                    {coa.account_type}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function IncompleteTransactionsModal({
  isOpen,
  onClose,
  entityId,
  sourceId,
  onUpdate,
}: IncompleteTransactionsModalProps) {
  const [transactions, setTransactions] = useState<IncompleteTransaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [categorizedCount, setCategorizedCount] = useState(0);
  const [chartOfAccounts, setChartOfAccounts] = useState<ChartOfAccountsEntry[]>([]);
  const [suggestions, setSuggestions] = useState<Map<string, AISuggestion>>(new Map());
  const [loading, setLoading] = useState(true);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [aiLoading, setAiLoading] = useState(false);

  // Fetch data on open
  const fetchData = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    try {
      const [txnResult, coaResult] = await Promise.all([
        getIncompleteTransactions(sourceId, 50, 0),
        getChartOfAccounts(), // Fetch all account types, not just expense
      ]);
      if (txnResult) {
        setTransactions(txnResult.transactions);
        setTotalCount(txnResult.total_count);
      }
      setChartOfAccounts(coaResult);
    } catch (error) {
      console.error('Failed to fetch data:', error);
      toast.error('Failed to load transactions');
    } finally {
      setLoading(false);
    }
  }, [isOpen, sourceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSuggestions(new Map());
      setCategorizedCount(0);
    }
  }, [isOpen]);

  // Handle AI categorization
  const handleAiCategorize = async () => {
    if (transactions.length === 0) return;
    setAiLoading(true);
    try {
      const ids = transactions.map(t => t.id);
      const result = await aiCategorizeTransactions(ids);
      if (result) {
        const newSuggestions = new Map<string, AISuggestion>();
        result.forEach(s => newSuggestions.set(s.transaction_id, s));
        setSuggestions(newSuggestions);
        toast.success(`AI analysed ${result.length} transactions`);
      }
    } catch (error) {
      console.error('AI categorization failed:', error);
      toast.error('AI categorization failed');
    } finally {
      setAiLoading(false);
    }
  };

  // Handle categorize a single transaction
  const handleCategorize = async (txnId: string, accountNumber: string) => {
    setSavingIds(prev => new Set(prev).add(txnId));
    try {
      const result = await updateTransactionCategory(txnId, accountNumber);
      if (result) {
        // Remove from list
        setTransactions(prev => prev.filter(t => t.id !== txnId));
        setCategorizedCount(prev => prev + 1);
        setTotalCount(prev => Math.max(prev - 1, 0));

        const account = chartOfAccounts.find(c => c.account_number === accountNumber);
        toast.success(`Assigned to ${account?.name || accountNumber}`, { duration: 2000 });
        onUpdate?.();
      }
    } catch (error) {
      console.error('Failed to categorize:', error);
      toast.error('Failed to assign category');
    } finally {
      setSavingIds(prev => {
        const next = new Set(prev);
        next.delete(txnId);
        return next;
      });
    }
  };

  // Remaining count
  const remainingCount = transactions.length;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-2xl max-h-[85vh] mx-4 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
              <Warning size={20} weight="fill" className="text-orange-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Review Transactions</h2>
              <p className="text-sm text-muted-foreground">
                {remainingCount === 0
                  ? 'All done!'
                  : `${remainingCount} uncategorised transaction${remainingCount !== 1 ? 's' : ''} to review`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {remainingCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleAiCategorize}
                disabled={aiLoading || transactions.length === 0}
                className="gap-2"
              >
                {aiLoading ? (
                  <ArrowsClockwise size={14} className="animate-spin" />
                ) : (
                  <Sparkle size={14} weight="fill" />
                )}
                AI Suggest All
              </Button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <ArrowsClockwise size={24} className="animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">Loading transactions...</p>
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
                <CheckCircle size={28} weight="fill" className="text-emerald-400" />
              </div>
              <p className="text-foreground font-semibold text-lg">All caught up!</p>
              <p className="text-sm text-muted-foreground mt-1 text-center max-w-xs">
                {categorizedCount > 0
                  ? `You categorised ${categorizedCount} transaction${categorizedCount !== 1 ? 's' : ''} in this session.`
                  : 'No uncategorised transactions remaining.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {transactions.map(txn => (
                <TransactionRow
                  key={txn.id}
                  transaction={txn}
                  chartOfAccounts={chartOfAccounts}
                  suggestion={suggestions.get(txn.id)}
                  onCategorize={handleCategorize}
                  isSaving={savingIds.has(txn.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {(remainingCount > 0 || categorizedCount > 0) && (
          <div className="flex items-center justify-between p-3 border-t border-border bg-muted/30 shrink-0">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {categorizedCount > 0 && (
                <span className="flex items-center gap-1">
                  <Check size={12} weight="bold" className="text-emerald-400" />
                  {categorizedCount} categorised this session
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={onClose}>
              {remainingCount === 0 ? 'Done' : 'Close'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
