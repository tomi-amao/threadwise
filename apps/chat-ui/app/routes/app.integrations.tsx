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
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { cn } from '~/lib/utils';
import { useAuth } from '~/providers/AuthProvider';
import {
  getIntegrationsSummary,
  triggerSync,
  createExternalSource,
  validateApiKey,
  type IntegrationSummary,
} from '~/lib/api/integrations';
import { SyncProgressToast } from '~/components/integrations/SyncProgressToast';

// Provider configuration
const PROVIDERS = {
  squarespace: {
    name: 'Squarespace',
    icon: <Storefront size={24} weight="duotone" className="text-orange-400" />,
    description: 'Sync products, orders, inventory, and store pages from Squarespace Commerce',
    endpoints: ['products', 'orders', 'inventory', 'store_pages'],
    color: 'orange',
  },
  revolut: {
    name: 'Revolut',
    icon: <PlugsConnected size={24} weight="duotone" className="text-blue-400" />,
    description: 'Sync transactions and accounts from Revolut Business',
    endpoints: ['transactions', 'accounts'],
    color: 'blue',
  },
};

// Endpoint icons for visual distinction
const endpointIcons: Record<string, React.ReactNode> = {
  products: <Package size={14} weight="duotone" />,
  orders: <ShoppingCart size={14} weight="duotone" />,
  inventory: <Cube size={14} weight="duotone" />,
  store_pages: <FileText size={14} weight="duotone" />,
  transactions: <ArrowsClockwise size={14} weight="duotone" />,
  accounts: <Buildings size={14} weight="duotone" />,
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
  isSyncing,
  syncingEndpoint,
  isValidatingApiKey,
}: {
  integration: IntegrationSummary;
  onSync: () => void;
  onSyncEndpoint: (endpoint: string) => void;
  onValidateApiKey: () => void;
  isSyncing: boolean;
  syncingEndpoint: string | null;
  isValidatingApiKey: boolean;
}) {
  const providerConfig = PROVIDERS[integration.provider as keyof typeof PROVIDERS];

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
          </div>
        )}

        {/* Sync Error Message */}
        {integration.sync_error && (
          <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <p className="text-sm text-red-400 font-medium">Sync Error</p>
            <p className="text-sm text-red-400/80 mt-1">{integration.sync_error}</p>
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
          >
            <Trash size={14} weight="bold" className="mr-2" />
            Remove
          </Button>
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
  const [provider, setProvider] = useState<'squarespace' | 'revolut'>('squarespace');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!entity?.id) {
      setError('No entity associated with your account');
      return;
    }

    if (!externalAccountId || !apiKey) {
      setError('Please fill in all required fields');
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
        api_key: apiKey,
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

  const providerConfig = PROVIDERS[provider];

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
                onClick={() => setProvider(key as 'squarespace' | 'revolut')}
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
            {provider === 'squarespace' ? 'Site ID' : 'Business ID'}
            <span className="text-destructive ml-1">*</span>
          </label>
          <Input
            placeholder={
              provider === 'squarespace'
                ? 'Enter your Squarespace site ID'
                : 'Enter your Revolut business ID'
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

        {/* API Key */}
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
  const [showAddForm, setShowAddForm] = useState(false);
  const [activeSyncSource, setActiveSyncSource] = useState<{
    id: string;
    name: string;
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
                isSyncing={syncingIds.has(integration.id)}
                syncingEndpoint={syncingEndpoints.get(integration.id) || null}
                isValidatingApiKey={validatingIds.has(integration.id)}
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
      </div>
    </div>
  );
}
