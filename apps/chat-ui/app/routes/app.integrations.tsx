/**
 * Integrations Page
 *
 * Full page view for managing external integrations.
 * Allows adding new connections, viewing sync history, and managing credentials.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  ArrowsClockwise,
  Check,
  Warning,
  Clock,
  PlugsConnected,
  Plus,
  Storefront,
  Trash,
  Eye,
  EyeSlash,
  ShieldCheck,
  ShieldWarning,
  Buildings,
  Package,
  ShoppingCart,
  Cube,
  FileText,
  Sparkle,
  Bank,
  Coins,
  UserCircle,
  Database,
  CaretDown,
  CurrencyCircleDollar,
  BookOpen,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { cn } from '~/lib/utils';
import { useAuth } from '~/providers/AuthProvider';
import {
  getIntegrationsSummary,
  triggerSync,
  triggerNormalization,
  createExternalSource,
  validateApiKey,
  reprocessFailedEvents,
  deleteExternalSource,
  type IntegrationSummary,
} from '~/lib/api/integrations';
import { SyncProgressToast } from '~/components/integrations/SyncProgressToast';
import { NormalizationProgressToast } from '~/components/integrations/NormalizationProgressToast';
import { IncompleteTransactionsModal } from '~/components/integrations/IncompleteTransactionsModal';
import { JournalCreationModal } from '~/components/integrations/JournalCreationModal';

// Provider configuration
const PROVIDERS = {
  squarespace: {
    name: 'Squarespace',
    icon: <Storefront size={24} weight="duotone" className="text-orange-400" />,
    description:
      'Sync products, orders, inventory, profiles, transactions, and store pages from Squarespace Commerce',
    endpoints: ['products', 'orders', 'inventory', 'profiles', 'transactions'],
    color: 'orange',
  },
  revolut: {
    name: 'Revolut',
    icon: <Bank size={24} weight="duotone" className="text-blue-400" />,
    description: 'Sync transactions, accounts, and expenses from Revolut Business',
    endpoints: ['transactions', 'accounts', 'expenses'],
    color: 'blue',
  },
  paypal: {
    name: 'PayPal',
    icon: <Coins size={24} weight="duotone" className="text-indigo-400" />,
    description: 'Sync transactions and balances from PayPal Business',
    endpoints: ['transactions'],
    color: 'indigo',
    credentialType: 'compound' as const,
  },
};

// Endpoint icons for visual distinction
const endpointIcons: Record<string, React.ReactNode> = {
  products: <Package size={14} weight="duotone" />,
  orders: <ShoppingCart size={14} weight="duotone" />,
  inventory: <Cube size={14} weight="duotone" />,
  store_pages: <FileText size={14} weight="duotone" />,
  profiles: <UserCircle size={14} weight="duotone" />,
  transactions: <Coins size={14} weight="duotone" />,
  accounts: <Buildings size={14} weight="duotone" />,
  expenses: <Coins size={14} weight="duotone" />,
};

// Status styles
const statusStyles: Record<
  string,
  { bg: string; text: string; icon: React.ReactNode; ring?: string }
> = {
  idle: {
    bg: 'bg-gray-500/10',
    text: 'text-gray-400',
    icon: <Clock size={14} weight="bold" />,
    ring: 'ring-gray-500/20',
  },
  syncing: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    icon: <ArrowsClockwise size={14} weight="bold" className="animate-spin" />,
    ring: 'ring-blue-500/30',
  },
  completed: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    icon: <Check size={14} weight="bold" />,
    ring: 'ring-emerald-500/20',
  },
  error: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    icon: <Warning size={14} weight="bold" />,
    ring: 'ring-red-500/20',
  },
};

function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] || statusStyles.idle;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium',
        style.bg,
        style.text
      )}
    >
      {style.icon}
      <span className="capitalize">{status}</span>
    </span>
  );
}

// API Key status badge component
function ApiKeyStatusBadge({
  status,
  error,
  lastValidated,
  isValidating,
  onValidate,
}: {
  status: 'pending' | 'valid' | 'invalid' | 'expired' | null;
  error?: string | null;
  lastValidated?: string | null;
  isValidating: boolean;
  onValidate: () => void;
}) {
  const styles: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
    pending: {
      bg: 'bg-yellow-500/10',
      text: 'text-yellow-600',
      icon: <Clock size={14} weight="bold" />,
    },
    valid: {
      bg: 'bg-green-500/10',
      text: 'text-green-600',
      icon: <ShieldCheck size={14} weight="bold" />,
    },
    invalid: {
      bg: 'bg-red-500/10',
      text: 'text-red-600',
      icon: <ShieldWarning size={14} weight="bold" />,
    },
    expired: {
      bg: 'bg-orange-500/10',
      text: 'text-orange-600',
      icon: <Warning size={14} weight="bold" />,
    },
  };

  const style = styles[status || 'pending'] || styles.pending;

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium',
          style.bg,
          style.text
        )}
        title={error || undefined}
      >
        {style.icon}
        <span className="capitalize">API Key: {status || 'pending'}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onValidate}
        disabled={isValidating}
        className="h-6 px-2 text-xs"
        title="Validate API key"
      >
        <ArrowsClockwise size={12} className={cn(isValidating && 'animate-spin')} />
      </Button>
    </div>
  );
}

function IntegrationCard({
  integration,
  onSync,
  onSyncEndpoint,
  onValidateApiKey,
  onUpdateApiKey,
  onLoadData,
  onReprocessFailed,
  onRemove,
  onViewUncategorized,
  onCreateJournals,
  isSyncing,
  syncingEndpoint,
  isValidatingApiKey,
  isNormalizing,
  isReprocessing,
  isRemoving,
}: {
  integration: IntegrationSummary;
  onSync: () => void;
  onSyncEndpoint: (endpoint: string) => void;
  onValidateApiKey: () => void;
  onUpdateApiKey: (apiKey: string) => void;
  onLoadData: (mode: 'hard' | 'soft') => void;
  onReprocessFailed: () => void;
  onRemove: () => void;
  onViewUncategorized: () => void;
  onCreateJournals: () => void;
  isSyncing: boolean;
  syncingEndpoint: string | null;
  isValidatingApiKey: boolean;
  isNormalizing: boolean;
  isReprocessing: boolean;
  isRemoving: boolean;
}) {
  const providerConfig = PROVIDERS[integration.provider as keyof typeof PROVIDERS];
  const [showUpdateApiKey, setShowUpdateApiKey] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');

  // Format relative time
  const formatRelativeTime = (dateStr: string | null) => {
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
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Calculate total items
  const totalItems = integration.stats
    ? Object.values(integration.stats).reduce((a, b) => a + b, 0)
    : 0;

  const isSyncActive = isSyncing || integration.sync_status === 'syncing';

  return (
    <div
      className={cn(
        'group relative bg-card rounded-2xl border border-border overflow-hidden',
        'transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5',
        isSyncActive && 'ring-2 ring-blue-500/20'
      )}
    >
      {/* Gradient accent bar */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 h-1',
          integration.sync_status === 'completed' &&
            'bg-gradient-to-r from-emerald-500 to-emerald-400',
          integration.sync_status === 'syncing' && 'bg-gradient-to-r from-blue-500 to-blue-400',
          integration.sync_status === 'error' && 'bg-gradient-to-r from-red-500 to-red-400',
          integration.sync_status === 'idle' && 'bg-gradient-to-r from-gray-500 to-gray-400'
        )}
      />

      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <div
              className={cn(
                'w-14 h-14 rounded-2xl flex items-center justify-center',
                'bg-gradient-to-br from-muted to-muted/50',
                'ring-1 ring-border/50'
              )}
            >
              {providerConfig?.icon || <PlugsConnected size={28} weight="duotone" />}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
                {integration.display_name || providerConfig?.name || integration.provider}
                {integration.sync_status === 'completed' && (
                  <Sparkle size={16} weight="fill" className="text-emerald-400" />
                )}
              </h3>
              <p className="text-sm text-muted-foreground">
                {integration.entity_name || integration.external_account_id}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <StatusBadge status={integration.sync_status} />
            <ApiKeyStatusBadge
              status={integration.api_key_status}
              error={integration.api_key_error}
              lastValidated={integration.api_key_last_validated_at}
              isValidating={isValidatingApiKey}
              onValidate={onValidateApiKey}
            />
          </div>
        </div>

        {/* API Key Error Message */}
        {integration.api_key_status === 'invalid' && integration.api_key_error && (
          <div className="mb-4 p-3 rounded-xl bg-orange-500/10 border border-orange-500/20">
            <p className="text-sm text-orange-500 font-medium">API Key Issue</p>
            <p className="text-sm text-orange-500/80 mt-1">{integration.api_key_error}</p>
            <button
              onClick={() => setShowUpdateApiKey(true)}
              className="mt-2 text-xs text-orange-400 hover:text-orange-300 underline"
            >
              Update API Key
            </button>
          </div>
        )}

        {/* Update API Key Form */}
        {showUpdateApiKey && (
          <div className="mb-4 p-3 rounded-xl bg-muted/50 border border-border">
            <p className="text-sm font-medium text-foreground mb-2">Update API Key</p>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="Enter new API key"
                value={newApiKey}
                onChange={e => setNewApiKey(e.target.value)}
                className="flex-1 text-sm"
              />
              <Button
                size="sm"
                onClick={() => {
                  if (newApiKey.trim()) {
                    onUpdateApiKey(newApiKey.trim());
                    setNewApiKey('');
                    setShowUpdateApiKey(false);
                  }
                }}
                disabled={!newApiKey.trim()}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowUpdateApiKey(false);
                  setNewApiKey('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Sync Error Message */}
        {integration.sync_error && (
          <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <p className="text-sm text-red-400 font-medium">Sync Error</p>
            <p className="text-sm text-red-400/80 mt-1">{integration.sync_error}</p>
          </div>
        )}

        {/* Failed Events Warning */}
        {integration.failed_events_count > 0 && (
          <div className="mb-4 p-4 rounded-xl bg-orange-500/10 border border-orange-500/20">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <Warning size={20} weight="fill" className="text-orange-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-orange-400 font-medium">
                    {integration.failed_events_count} Failed Event
                    {integration.failed_events_count !== 1 ? 's' : ''}
                  </p>
                  <p className="text-sm text-orange-400/80 mt-1">
                    Some events failed to process. Click "Retry Failed Events" to reprocess them.
                  </p>
                </div>
              </div>
              <Button
                onClick={onReprocessFailed}
                disabled={isReprocessing || isSyncing}
                variant="outline"
                size="sm"
                className={cn(
                  'shrink-0',
                  'hover:bg-orange-500/10 hover:border-orange-500/30 hover:text-orange-400'
                )}
              >
                {isReprocessing ? (
                  <>
                    <ArrowsClockwise size={14} weight="bold" className="mr-2 animate-spin" />
                    Retrying...
                  </>
                ) : (
                  <>
                    <ArrowsClockwise size={14} weight="bold" className="mr-2" />
                    Retry Failed Events
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Uncategorized Transactions Warning */}
        {integration.uncategorized_transactions_count > 0 && (
          <div className="mb-4 p-4 rounded-xl bg-purple-500/10 border border-purple-500/20">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <CurrencyCircleDollar
                  size={20}
                  weight="fill"
                  className="text-purple-400 shrink-0 mt-0.5"
                />
                <div>
                  <p className="text-sm text-purple-400 font-medium">
                    {integration.uncategorized_transactions_count} Uncategorized Transaction
                    {integration.uncategorized_transactions_count !== 1 ? 's' : ''}
                  </p>
                  <p className="text-sm text-purple-400/80 mt-1">
                    Transactions missing expense category assignment. Categorize them to enable
                    journal creation.
                  </p>
                </div>
              </div>
              <Button
                onClick={onViewUncategorized}
                variant="outline"
                size="sm"
                className="shrink-0 hover:bg-purple-500/10 hover:border-purple-500/30 hover:text-purple-400"
              >
                <Sparkle size={14} weight="fill" className="mr-2" />
                Review & Categorize
              </Button>
            </div>
          </div>
        )}

        {/* Stats Grid - Redesigned */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {/* Last Synced */}
          <div className="bg-gradient-to-br from-muted/80 to-muted/40 rounded-xl p-4 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Clock size={14} className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Last Sync
              </p>
            </div>
            <p className="text-lg font-semibold text-foreground">
              {formatRelativeTime(integration.last_synced_at)}
            </p>
          </div>

          {/* Total Items */}
          <div className="bg-gradient-to-br from-primary/10 to-primary/5 rounded-xl p-4 border border-primary/20">
            <div className="flex items-center gap-2 mb-1">
              <Cube size={14} className="text-primary" />
              <p className="text-xs text-primary font-medium uppercase tracking-wide">
                Total Items
              </p>
            </div>
            <p className="text-lg font-semibold text-foreground">{totalItems.toLocaleString()}</p>
          </div>

          {/* Individual Stats */}
          {integration.stats &&
            Object.entries(integration.stats)
              .slice(0, 2)
              .map(([type, count]) => {
                const icon = endpointIcons[type] || <Package size={14} />;
                return (
                  <div
                    key={type}
                    className="bg-gradient-to-br from-muted/80 to-muted/40 rounded-xl p-4 border border-border/50"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-muted-foreground">{icon}</span>
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                        {type}
                      </p>
                    </div>
                    <p className="text-lg font-semibold text-foreground">
                      {count.toLocaleString()}
                    </p>
                  </div>
                );
              })}
        </div>

        {/* Endpoint Sync Chips - Redesigned */}
        {providerConfig?.endpoints && (
          <div className="mb-6">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-3">
              Sync Endpoints
            </p>
            <div className="flex flex-wrap gap-2">
              {providerConfig.endpoints.map(endpoint => {
                const isEndpointSyncing = syncingEndpoint === endpoint;
                const icon = endpointIcons[endpoint];
                const stat = integration.stats?.[endpoint];

                return (
                  <button
                    key={endpoint}
                    onClick={() => onSyncEndpoint(endpoint)}
                    disabled={isSyncActive || isEndpointSyncing}
                    className={cn(
                      'group/chip flex items-center gap-2 px-3 py-2 rounded-xl',
                      'bg-muted/50 border border-border/50',
                      'hover:bg-muted hover:border-border',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'transition-all duration-200',
                      isEndpointSyncing && 'ring-2 ring-blue-500/30 bg-blue-500/10'
                    )}
                  >
                    <span className="text-muted-foreground group-hover/chip:text-foreground transition-colors">
                      {isEndpointSyncing ? (
                        <ArrowsClockwise size={14} className="animate-spin text-blue-400" />
                      ) : (
                        icon
                      )}
                    </span>
                    <span className="text-sm font-medium text-foreground capitalize">
                      {endpoint}
                    </span>
                    {stat !== undefined && (
                      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-md">
                        {stat.toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            disabled={isRemoving}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${integration.display_name || integration.provider}? This will delete all synced data and cannot be undone.`
                )
              ) {
                onRemove();
              }
            }}
          >
            {isRemoving ? (
              <>
                <ArrowsClockwise size={14} weight="bold" className="mr-2 animate-spin" />
                Removing...
              </>
            ) : (
              <>
                <Trash size={14} weight="bold" className="mr-2" />
                Remove
              </>
            )}
          </Button>
          <div className="flex items-center gap-2">
            {/* Create Journals button - visible when data has been synced and entity exists */}
            {integration.entity_id &&
              (integration.sync_status === 'completed' ||
                (integration.stats &&
                  Object.values(integration.stats).reduce((a, b) => a + b, 0) > 0)) && (
                <Button
                  onClick={onCreateJournals}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
                >
                  <BookOpen size={14} weight="duotone" />
                  Create Journals
                </Button>
              )}
            {/* Load Data button (normalization) - visible when data has been synced */}
            {(integration.sync_status === 'completed' ||
              (integration.stats &&
                Object.values(integration.stats).reduce((a, b) => a + b, 0) > 0)) && (
              <LoadDataButton
                onLoadData={onLoadData}
                disabled={isSyncActive || isNormalizing}
                isNormalizing={isNormalizing}
              />
            )}
            <Button
              onClick={onSync}
              disabled={isSyncActive}
              className={cn(
                'bg-gradient-to-r from-primary to-primary/90',
                'hover:from-primary/90 hover:to-primary/80',
                'shadow-lg shadow-primary/20'
              )}
            >
              {isSyncActive ? (
                <>
                  <ArrowsClockwise size={16} weight="bold" className="mr-2 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <ArrowsClockwise size={16} weight="bold" className="mr-2" />
                  Sync All Data
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Load Data Button with hard/soft mode dropdown
 *
 * Appears on integration cards after data has been synced.
 * Soft mode (default): Only processes new/pending events.
 * Hard mode: Resets everything and reprocesses from scratch.
 */
function LoadDataButton({
  onLoadData,
  disabled,
  isNormalizing,
}: {
  onLoadData: (mode: 'hard' | 'soft') => void;
  disabled: boolean;
  isNormalizing: boolean;
}) {
  const [showModeMenu, setShowModeMenu] = useState(false);

  return (
    <div className="relative">
      <div className="flex items-center">
        {/* Main button - soft mode by default */}
        <Button
          onClick={() => onLoadData('soft')}
          disabled={disabled}
          variant="outline"
          className={cn(
            'rounded-r-none border-r-0',
            'hover:bg-purple-500/10 hover:border-purple-500/30 hover:text-purple-400',
            isNormalizing && 'border-purple-500/30 bg-purple-500/10 text-purple-400'
          )}
        >
          {isNormalizing ? (
            <>
              <Database size={16} weight="bold" className="mr-2 animate-pulse" />
              Loading...
            </>
          ) : (
            <>
              <Database size={16} weight="bold" className="mr-2" />
              Load Data
            </>
          )}
        </Button>
        {/* Mode dropdown toggle */}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            'rounded-l-none px-2',
            'hover:bg-purple-500/10 hover:border-purple-500/30 hover:text-purple-400'
          )}
          onClick={() => setShowModeMenu(!showModeMenu)}
        >
          <CaretDown size={14} />
        </Button>
      </div>

      {/* Mode dropdown menu */}
      {showModeMenu && (
        <div
          className={cn(
            'absolute right-0 bottom-full mb-2 w-64 z-50',
            'bg-card border border-border rounded-xl shadow-xl',
            'animate-in fade-in slide-in-from-bottom-2 duration-150'
          )}
          onMouseLeave={() => setShowModeMenu(false)}
        >
          <div className="p-2">
            <button
              onClick={() => {
                onLoadData('soft');
                setShowModeMenu(false);
              }}
              className="w-full text-left p-3 rounded-lg hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-foreground">Soft Load</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400">
                  DEFAULT
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Only processes new or pending events. Safe to re-run.
              </p>
            </button>
            <button
              onClick={() => {
                onLoadData('hard');
                setShowModeMenu(false);
              }}
              className="w-full text-left p-3 rounded-lg hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-foreground">Hard Load</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400">
                  RESET
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Resets all events to pending and reprocesses everything from scratch.
              </p>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddIntegrationForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { entity } = useAuth();
  const [provider, setProvider] = useState<keyof typeof PROVIDERS>('squarespace');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const providerConfig = PROVIDERS[provider];
  const isCompound =
    'credentialType' in providerConfig && providerConfig.credentialType === 'compound';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!entity?.id) {
      setError('No entity associated with your account');
      return;
    }

    if (!externalAccountId) {
      setError('Please fill in the account ID');
      return;
    }

    // Validate credentials based on type
    let resolvedApiKey = apiKey;
    if (isCompound) {
      if (!clientId || !clientSecret) {
        setError('Please fill in both Client ID and Secret');
        return;
      }
      resolvedApiKey = JSON.stringify({ client_id: clientId, secret: clientSecret });
    } else if (!apiKey) {
      setError('Please fill in the API key');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await createExternalSource({
        entity_id: entity.id,
        provider,
        external_account_id: externalAccountId,
        display_name: displayName || undefined,
        api_key: resolvedApiKey,
      });

      if (result) {
        onSuccess();
      } else {
        setError('Failed to create integration');
      }
    } catch (err) {
      setError('Error creating integration');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-primary/10 to-primary/5 px-6 py-4 border-b border-border">
        <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Plus size={20} weight="duotone" className="text-primary" />
          Add New Integration
        </h3>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-6">
        {/* Connected Entity Display */}
        <div className="p-4 rounded-xl bg-muted/50 border border-border">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
              <Buildings size={22} weight="duotone" className="text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Connected Business
              </p>
              <p className="font-semibold text-foreground mt-0.5">
                {entity?.name || 'No entity connected'}
              </p>
            </div>
          </div>
        </div>

        {/* Provider Selection - Enhanced */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-3">Select Provider</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {Object.entries(PROVIDERS).map(([key, config]) => (
              <button
                key={key}
                type="button"
                onClick={() => setProvider(key as keyof typeof PROVIDERS)}
                className={cn(
                  'p-5 rounded-xl border-2 text-left transition-all duration-200',
                  'hover:shadow-lg hover:shadow-primary/5',
                  provider === key
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                    : 'border-border hover:border-primary/30'
                )}
              >
                <div className="flex items-center gap-3 mb-2">
                  {config.icon}
                  <span className="font-semibold text-foreground">{config.name}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{config.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* External Account ID */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {provider === 'squarespace'
              ? 'Site ID'
              : provider === 'revolut'
                ? 'Business ID'
                : 'Account Email'}
            <span className="text-destructive ml-1">*</span>
          </label>
          <Input
            placeholder={
              provider === 'squarespace'
                ? 'Enter your Squarespace site ID'
                : provider === 'revolut'
                  ? 'Enter your Revolut business ID'
                  : 'Enter your PayPal account email'
            }
            value={externalAccountId}
            onChange={e => setExternalAccountId(e.target.value)}
            className="h-11"
          />
        </div>

        {/* Display Name */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Display Name <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Input
            placeholder="My Store"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className="h-11"
          />
        </div>

        {/* Credentials */}
        {isCompound ? (
          <>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Client ID
                <span className="text-destructive ml-1">*</span>
              </label>
              <Input
                placeholder="Enter your PayPal Client ID"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                className="h-11"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Secret
                <span className="text-destructive ml-1">*</span>
              </label>
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  placeholder="Enter your PayPal Secret"
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                  className="pr-10 h-11"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showApiKey ? <EyeSlash size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Get your Client ID and Secret from the PayPal Developer Dashboard under REST API
                apps
              </p>
            </div>
          </>
        ) : (
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              API Key
              <span className="text-destructive ml-1">*</span>
            </label>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                placeholder="Enter your API key"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                className="pr-10 h-11"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiKey ? <EyeSlash size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {provider === 'squarespace'
                ? 'Generate an API key from Squarespace Settings → Advanced → Developer API Keys'
                : 'Get your API key from Revolut Business Settings'}
            </p>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
            <Warning size={16} weight="fill" className="text-red-400 shrink-0" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-6 border-t border-border">
          <Button type="button" variant="outline" onClick={onCancel} className="px-6">
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={loading}
            className={cn(
              'px-6 bg-gradient-to-r from-primary to-primary/90',
              'hover:from-primary/90 hover:to-primary/80',
              'shadow-lg shadow-primary/20'
            )}
          >
            {loading ? (
              <>
                <ArrowsClockwise size={16} weight="bold" className="mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus size={16} weight="bold" className="mr-2" />
                Add Integration
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function IntegrationsPage() {
  const { entity } = useAuth();
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [syncingEndpoints, setSyncingEndpoints] = useState<Map<string, string>>(new Map());
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set());
  const [normalizingIds, setNormalizingIds] = useState<Set<string>>(new Set());
  const [reprocessingIds, setReprocessingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [activeSyncSource, setActiveSyncSource] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [activeNormalizeSource, setActiveNormalizeSource] = useState<{
    id: string;
    name: string;
    mode: 'hard' | 'soft';
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const stored = localStorage.getItem('threadwise:activeNormalizeSource');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  // Persist activeNormalizeSource to localStorage so the toast survives page reloads
  useEffect(() => {
    if (activeNormalizeSource) {
      localStorage.setItem(
        'threadwise:activeNormalizeSource',
        JSON.stringify(activeNormalizeSource)
      );
    } else {
      localStorage.removeItem('threadwise:activeNormalizeSource');
    }
  }, [activeNormalizeSource]);
  const [uncategorizedModalSource, setUncategorizedModalSource] = useState<{
    id: string;
    entityId?: string;
  } | null>(null);
  const [journalModalSource, setJournalModalSource] = useState<{
    entityId: string;
    providerName: string;
  } | null>(null);

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const integrationsData = await getIntegrationsSummary(entity?.id);
      setIntegrations(integrationsData);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }, [entity?.id]);

  useEffect(() => {
    fetchData();
    // Poll for updates
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Close sync progress dialog
  const handleCloseSyncProgress = () => {
    setActiveSyncSource(null);
    // Refresh the list when closing
    fetchData();
  };

  // Close normalization progress dialog
  const handleCloseNormalizeProgress = () => {
    setActiveNormalizeSource(null);
    fetchData();
  };

  // Handle load data (normalization)
  const handleLoadData = async (sourceId: string, mode: 'hard' | 'soft') => {
    setNormalizingIds(prev => new Set([...prev, sourceId]));

    const integration = integrations.find(i => i.id === sourceId);
    const name = integration?.display_name || integration?.provider || '';

    setActiveNormalizeSource({ id: sourceId, name, mode });
    toast.loading(`Loading data (${mode} mode)...`, { id: `normalize-${sourceId}` });

    try {
      const response = await triggerNormalization(sourceId, mode);
      if (response?.status !== 'triggered') {
        throw new Error('Normalization did not trigger successfully');
      }
      toast.success(`Data loading triggered (${mode} mode)`, { id: `normalize-${sourceId}` });
    } catch (error) {
      console.error('Failed to trigger normalization:', error);
      toast.error('Failed to trigger data loading', { id: `normalize-${sourceId}` });
      setActiveNormalizeSource(null);
    } finally {
      setNormalizingIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  // Handle sync
  const handleSync = async (sourceId: string, endpoint?: string) => {
    setSyncingIds(prev => new Set([...prev, sourceId]));

    setActiveSyncSource({ id: sourceId, name: '' }); // Name can be set if needed
    if (endpoint) {
      setSyncingEndpoints(prev => new Map(prev).set(sourceId, endpoint));
      toast.loading(`Syncing ${endpoint}...`, { id: `sync-${sourceId}-${endpoint}` });
    } else {
      toast.loading('Syncing all data...', { id: `sync-${sourceId}` });
    }

    try {
      const response = await triggerSync(sourceId, endpoint);
      if (response?.status != 'triggered') {
        throw new Error('Sync did not trigger successfully');
      }
      await fetchData();

      if (endpoint) {
        toast.success(`${endpoint} triggered successfully`, { id: `sync-${sourceId}-${endpoint}` });
      } else {
        toast.success('Full sync triggered successfully', { id: `sync-${sourceId}` });
      }
    } catch (error) {
      console.error('Failed to trigger sync:', error);
      const message = endpoint ? `Failed to trigger ${endpoint}` : 'Failed to trigger sync';

      if (endpoint) {
        toast.error(message, { id: `sync-${sourceId}-${endpoint}` });
      } else {
        toast.error(message, { id: `sync-${sourceId}` });
      }
    } finally {
      setSyncingIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });

      if (endpoint) {
        setSyncingEndpoints(prev => {
          const next = new Map(prev);
          next.delete(sourceId);
          return next;
        });
      }
    }
  };

  // Handle API key validation
  const handleValidateApiKey = async (sourceId: string) => {
    setValidatingIds(prev => new Set([...prev, sourceId]));
    toast.loading('Validating API key...', { id: `validate-${sourceId}` });

    try {
      await validateApiKey(sourceId);
      await fetchData();
      toast.success('API key validated successfully', { id: `validate-${sourceId}` });
    } catch (error) {
      console.error('Failed to validate API key:', error);
      toast.error('Failed to validate API key', { id: `validate-${sourceId}` });
    } finally {
      setValidatingIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  // Handle API key update
  const handleUpdateApiKey = async (sourceId: string, apiKey: string) => {
    toast.loading('Updating API key...', { id: `update-key-${sourceId}` });

    try {
      const { updateApiKey: updateApiKeyFn } = await import('~/lib/api/integrations');
      const result = await updateApiKeyFn(sourceId, apiKey);
      if (result) {
        toast.success(result.message, { id: `update-key-${sourceId}` });
        await fetchData();
      } else {
        throw new Error('Failed to update API key');
      }
    } catch (error) {
      console.error('Failed to update API key:', error);
      toast.error('Failed to update API key', { id: `update-key-${sourceId}` });
    }
  };

  // Handle reprocessing failed events
  const handleReprocessFailed = async (sourceId: string) => {
    setReprocessingIds(prev => new Set([...prev, sourceId]));
    toast.loading('Reprocessing failed events...', { id: `reprocess-${sourceId}` });

    try {
      const result = await reprocessFailedEvents(sourceId, 100);
      if (result?.status === 'queued') {
        toast.success('Failed events queued for reprocessing', { id: `reprocess-${sourceId}` });
        // Refresh data after a short delay
        setTimeout(() => fetchData(), 2000);
      } else {
        throw new Error('Failed to trigger reprocessing');
      }
    } catch (error) {
      console.error('Failed to reprocess events:', error);
      toast.error('Failed to reprocess events', { id: `reprocess-${sourceId}` });
    } finally {
      setReprocessingIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  // Handle removing an integration
  const handleRemove = async (sourceId: string) => {
    setRemovingIds(prev => new Set([...prev, sourceId]));
    toast.loading('Removing integration...', { id: `remove-${sourceId}` });

    try {
      const result = await deleteExternalSource(sourceId);
      if (result?.status === 'deleted') {
        toast.success(`Integration removed (${result.events_deleted} events deleted)`, {
          id: `remove-${sourceId}`,
        });
        await fetchData();
      } else {
        throw new Error('Failed to delete integration');
      }
    } catch (error) {
      console.error('Failed to remove integration:', error);
      toast.error('Failed to remove integration', { id: `remove-${sourceId}` });
    } finally {
      setRemovingIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="max-w-5xl mx-auto p-6 lg:p-8">
        {/* Header - Enhanced */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
                <PlugsConnected size={20} weight="duotone" className="text-primary" />
              </div>
              <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
            </div>
            <p className="text-muted-foreground mt-2">
              Connect your external services to sync data automatically
            </p>
          </div>
          <Button
            onClick={() => setShowAddForm(!showAddForm)}
            className={cn(
              'bg-gradient-to-r from-primary to-primary/90',
              'hover:from-primary/90 hover:to-primary/80',
              'shadow-lg shadow-primary/20'
            )}
          >
            <Plus size={18} weight="bold" className="mr-2" />
            Add Integration
          </Button>
        </div>

        {/* Add Form */}
        {showAddForm && (
          <div className="mb-8">
            <AddIntegrationForm
              onSuccess={() => {
                setShowAddForm(false);
                fetchData();
              }}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        )}

        {/* Loading State - Enhanced */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center mb-4">
              <ArrowsClockwise size={28} weight="bold" className="animate-spin text-primary" />
            </div>
            <p className="text-muted-foreground">Loading integrations...</p>
          </div>
        ) : integrations.length === 0 && !showAddForm ? (
          /* Empty State - Enhanced */
          <div className="text-center py-20">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center mx-auto mb-6">
              <PlugsConnected size={36} weight="duotone" className="text-muted-foreground" />
            </div>
            <h3 className="text-xl font-semibold text-foreground">No integrations yet</h3>
            <p className="text-muted-foreground mt-2 max-w-md mx-auto">
              Connect your Squarespace or Revolut account to automatically sync products, orders,
              transactions, and more.
            </p>
            <Button
              onClick={() => setShowAddForm(true)}
              className={cn(
                'mt-6 bg-gradient-to-r from-primary to-primary/90',
                'hover:from-primary/90 hover:to-primary/80',
                'shadow-lg shadow-primary/20'
              )}
            >
              <Plus size={18} weight="bold" className="mr-2" />
              Add Your First Integration
            </Button>
          </div>
        ) : (
          /* Integrations List */
          <div className="space-y-6">
            {integrations.map(integration => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                onSync={() => handleSync(integration.id)}
                onSyncEndpoint={endpoint => handleSync(integration.id, endpoint)}
                onValidateApiKey={() => handleValidateApiKey(integration.id)}
                onUpdateApiKey={apiKey => handleUpdateApiKey(integration.id, apiKey)}
                onViewUncategorized={() =>
                  setUncategorizedModalSource({
                    id: integration.id,
                    entityId: integration.entity_id ?? undefined,
                  })
                }
                onCreateJournals={() => {
                  if (integration.entity_id) {
                    const providerConfig = {
                      squarespace: 'Squarespace',
                      revolut: 'Revolut',
                      paypal: 'PayPal',
                    } as const;
                    setJournalModalSource({
                      entityId: integration.entity_id,
                      providerName:
                        providerConfig[integration.provider as keyof typeof providerConfig] ||
                        integration.provider,
                    });
                  }
                }}
                onLoadData={mode => handleLoadData(integration.id, mode)}
                onReprocessFailed={() => handleReprocessFailed(integration.id)}
                onRemove={() => handleRemove(integration.id)}
                isSyncing={syncingIds.has(integration.id)}
                syncingEndpoint={syncingEndpoints.get(integration.id) || null}
                isValidatingApiKey={validatingIds.has(integration.id)}
                isNormalizing={normalizingIds.has(integration.id)}
                isReprocessing={reprocessingIds.has(integration.id)}
                isRemoving={removingIds.has(integration.id)}
              />
            ))}
          </div>
        )}

        {/* Sync Progress Toast - Non-blocking */}
        {activeSyncSource && (
          <SyncProgressToast
            sourceId={activeSyncSource.id}
            sourceName={activeSyncSource.name}
            onClose={handleCloseSyncProgress}
            onComplete={() => {
              fetchData();
            }}
          />
        )}

        {/* Normalization Progress Toast - Non-blocking */}
        {activeNormalizeSource && (
          <NormalizationProgressToast
            sourceId={activeNormalizeSource.id}
            sourceName={activeNormalizeSource.name}
            mode={activeNormalizeSource.mode}
            onClose={handleCloseNormalizeProgress}
            onComplete={() => {
              fetchData();
            }}
          />
        )}

        {/* Incomplete Transactions Modal */}
        {uncategorizedModalSource && (
          <IncompleteTransactionsModal
            isOpen={true}
            sourceId={uncategorizedModalSource.id}
            entityId={uncategorizedModalSource.entityId}
            onClose={() => {
              setUncategorizedModalSource(null);
              fetchData();
            }}
            onUpdate={fetchData}
          />
        )}

        {/* Journal Creation Modal */}
        {journalModalSource && (
          <JournalCreationModal
            isOpen={true}
            entityId={journalModalSource.entityId}
            providerName={journalModalSource.providerName}
            onClose={() => {
              setJournalModalSource(null);
              fetchData();
            }}
          />
        )}
      </div>
    </div>
  );
}
