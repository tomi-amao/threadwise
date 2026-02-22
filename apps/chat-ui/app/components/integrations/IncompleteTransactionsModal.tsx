/**
 * Incomplete Transactions Modal
 *
 * Shows financial transactions that need expense categorization.
 * Users can manually assign categories or use AI-powered auto-categorization.
 * Displays transactions as cards that can be navigated one at a time.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  X,
  CaretLeft,
  CaretRight,
  Sparkle,
  Check,
  ArrowsClockwise,
  CurrencyCircleDollar,
  Warning,
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
  const [currentIndex, setCurrentIndex] = useState(0);
  const [chartOfAccounts, setChartOfAccounts] = useState<ChartOfAccountsEntry[]>([]);
  const [suggestions, setSuggestions] = useState<Map<string, AISuggestion>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedAccountNumber, setSelectedAccountNumber] = useState<string | null>(null);

  // Fetch data on open
  const fetchData = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    try {
      const [txnResult, coaResult] = await Promise.all([
        getIncompleteTransactions(sourceId, 50, 0),
        getChartOfAccounts('expense'),
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
  }, [isOpen, entityId, sourceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(0);
      setSelectedAccountNumber(null);
      setSuggestions(new Map());
      setCategorizedCount(0);
    }
  }, [isOpen]);

  // Current transaction
  const currentTxn = transactions[currentIndex];

  // Get current suggestion
  const currentSuggestion = currentTxn ? suggestions.get(currentTxn.id) : null;

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

        // Auto-select the suggestion for current transaction
        const currentSug = currentTxn ? newSuggestions.get(currentTxn.id) : null;
        if (currentSug?.suggested_account_number) {
          setSelectedAccountNumber(currentSug.suggested_account_number);
        }
        toast.success(`AI categorized ${result.length} transactions`);
      }
    } catch (error) {
      console.error('AI categorization failed:', error);
      toast.error('AI categorization failed');
    } finally {
      setAiLoading(false);
    }
  };

  // Handle save category
  const handleSave = async () => {
    if (!currentTxn || !selectedAccountNumber) return;
    setSaving(true);
    try {
      const result = await updateTransactionCategory(currentTxn.id, selectedAccountNumber);
      if (result) {
        toast.success('Category assigned');
        // Remove from list and move to next
        const newTxns = transactions.filter((_, i) => i !== currentIndex);
        setTransactions(newTxns);
        setCategorizedCount(prev => prev + 1);
        if (currentIndex >= newTxns.length && newTxns.length > 0) {
          setCurrentIndex(newTxns.length - 1);
        }
        setSelectedAccountNumber(null);
        onUpdate?.();
      }
    } catch (error) {
      console.error('Failed to save:', error);
      toast.error('Failed to assign category');
    } finally {
      setSaving(false);
    }
  };

  // Handle navigation
  const goNext = () => {
    if (currentIndex < transactions.length - 1) {
      setCurrentIndex(prev => prev + 1);
      const nextTxn = transactions[currentIndex + 1];
      const sug = nextTxn ? suggestions.get(nextTxn.id) : null;
      setSelectedAccountNumber(sug?.suggested_account_number || null);
    }
  };

  const goPrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
      const prevTxn = transactions[currentIndex - 1];
      const sug = prevTxn ? suggestions.get(prevTxn.id) : null;
      setSelectedAccountNumber(sug?.suggested_account_number || null);
    }
  };

  // Apply AI suggestion
  const applySuggestion = () => {
    if (currentSuggestion?.suggested_account_number) {
      setSelectedAccountNumber(currentSuggestion.suggested_account_number);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-2xl mx-4 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
              <Warning size={20} weight="fill" className="text-orange-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Uncategorized Transactions</h2>
              <p className="text-sm text-muted-foreground">
                {totalCount} transaction{totalCount !== 1 ? 's' : ''} need
                {totalCount === 1 ? 's' : ''} categorization
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
              AI Auto-Categorize
            </Button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <ArrowsClockwise size={24} className="animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">Loading transactions...</p>
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Check size={32} weight="fill" className="text-emerald-400 mb-3" />
              <p className="text-foreground font-medium">All transactions categorized!</p>
              <p className="text-sm text-muted-foreground mt-1">
                No uncategorized transactions remaining.
              </p>
            </div>
          ) : (
            <>
              {/* Transaction Card */}
              {currentTxn && (
                <div className="bg-muted/50 rounded-xl border border-border p-4 mb-4">
                  {/* Navigation */}
                  <div className="flex items-center justify-between mb-3">
                    <button
                      onClick={goPrev}
                      disabled={currentIndex === 0}
                      className="p-1.5 rounded-lg hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <CaretLeft size={18} />
                    </button>
                    <span className="text-xs text-muted-foreground font-medium">
                      {currentIndex + 1} of {transactions.length}
                    </span>
                    <button
                      onClick={goNext}
                      disabled={currentIndex >= transactions.length - 1}
                      className="p-1.5 rounded-lg hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <CaretRight size={18} />
                    </button>
                  </div>

                  {/* Transaction Details */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CurrencyCircleDollar size={20} weight="duotone" className="text-primary" />
                        <span className="font-semibold text-foreground text-lg">
                          {currentTxn.direction === 'out' ? '-' : '+'}
                          {currentTxn.currency_code} {currentTxn.amount.toFixed(2)}
                        </span>
                      </div>
                      <span
                        className={cn(
                          'text-xs font-medium px-2 py-1 rounded-full',
                          currentTxn.transaction_type === 'payment'
                            ? 'bg-orange-500/10 text-orange-400'
                            : 'bg-blue-500/10 text-blue-400'
                        )}
                      >
                        {currentTxn.transaction_type}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-muted-foreground text-xs">Description</span>
                        <p className="text-foreground truncate">
                          {currentTxn.description || 'No description'}
                        </p>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-xs">Counterparty</span>
                        <p className="text-foreground truncate">
                          {currentTxn.counterparty_name || 'Unknown'}
                        </p>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-xs">Date</span>
                        <p className="text-foreground">
                          {new Date(currentTxn.occurred_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div>
                        <span className="text-muted-foreground text-xs">Source</span>
                        <p className="text-foreground capitalize">{currentTxn.source}</p>
                      </div>
                    </div>

                    {/* AI Suggestion Banner */}
                    {currentSuggestion && (
                      <div
                        className={cn(
                          'flex items-center justify-between p-3 rounded-lg border',
                          currentSuggestion.confidence >= 0.7
                            ? 'bg-emerald-500/10 border-emerald-500/20'
                            : currentSuggestion.confidence >= 0.5
                              ? 'bg-yellow-500/10 border-yellow-500/20'
                              : 'bg-muted border-border'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Sparkle
                            size={14}
                            weight="fill"
                            className={cn(
                              currentSuggestion.confidence >= 0.7
                                ? 'text-emerald-400'
                                : 'text-yellow-400'
                            )}
                          />
                          <div>
                            <p className="text-xs font-medium text-foreground">
                              AI suggests: {currentSuggestion.suggested_account_number} –{' '}
                              {chartOfAccounts.find(
                                c => c.account_number === currentSuggestion.suggested_account_number
                              )?.name || currentSuggestion.suggested_expense_category}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {Math.round(currentSuggestion.confidence * 100)}% confidence
                              {currentSuggestion.reasoning
                                ? ` · ${currentSuggestion.reasoning}`
                                : ''}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={applySuggestion}
                          className="text-xs"
                        >
                          Apply
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Category Selector */}
              <div>
                <p className="text-sm font-medium text-foreground mb-2">Assign Category</p>
                <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {chartOfAccounts.map(coa => (
                    <button
                      key={coa.id}
                      onClick={() => setSelectedAccountNumber(coa.account_number)}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 rounded-lg text-sm',
                        'transition-all duration-150',
                        selectedAccountNumber === coa.account_number
                          ? 'bg-primary/10 border border-primary/30 text-foreground'
                          : 'bg-muted/30 border border-transparent hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground w-10">
                          {coa.account_number}
                        </span>
                        <span>{coa.name}</span>
                      </div>
                      {selectedAccountNumber === coa.account_number && (
                        <Check size={14} weight="bold" className="text-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {transactions.length > 0 && (
          <div className="flex items-center justify-between p-4 border-t border-border">
            <p className="text-xs text-muted-foreground">
              {categorizedCount} categorized in this session
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!selectedAccountNumber || saving}
                className="gap-2"
              >
                {saving ? (
                  <ArrowsClockwise size={14} className="animate-spin" />
                ) : (
                  <Check size={14} weight="bold" />
                )}
                Save & Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
