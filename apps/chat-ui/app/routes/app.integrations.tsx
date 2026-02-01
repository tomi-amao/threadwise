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

// Provider configuration
const PROVIDERS = {
  squarespace: {
    name: 'Squarespace',
    icon: <Storefront size={24} weight="duotone" className="text-orange-400" />,
    description: 'Sync products, orders, inventory, and store pages from Squarespace Commerce',
    endpoints: ['products', 'orders', 'inventory', 'store_pages'],
  },
  revolut: {
    name: 'Revolut',
    icon: <PlugsConnected size={24} weight="duotone" className="text-blue-400" />,
    description: 'Sync transactions and accounts from Revolut Business',
    endpoints: ['transactions', 'accounts'],
  },
};

// Status styles
const statusStyles: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  idle: {
    bg: 'bg-gray-500/20',
    text: 'text-gray-400',
    icon: <Clock size={14} weight="bold" />,
  },
  syncing: {
    bg: 'bg-blue-500/20',
    text: 'text-blue-400',
    icon: <ArrowsClockwise size={14} weight="bold" className="animate-spin" />,
  },
  completed: {
    bg: 'bg-green-500/20',
    text: 'text-green-400',
    icon: <Check size={14} weight="bold" />,
  },
  error: {
    bg: 'bg-red-500/20',
    text: 'text-red-400',
    icon: <Warning size={14} weight="bold" />,
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

  // Format date
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  };

  // Calculate total items
  const totalItems = integration.stats
    ? Object.values(integration.stats).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
            {providerConfig?.icon || <PlugsConnected size={24} weight="duotone" />}
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {integration.display_name || providerConfig?.name || integration.provider}
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
        <div className="mt-4 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
          <p className="text-sm text-orange-600 font-medium">API Key Issue</p>
          <p className="text-sm text-orange-600/80 mt-1">{integration.api_key_error}</p>
        </div>
      )}

      {/* Sync Error Message */}
      {integration.sync_error && (
        <div className="mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <p className="text-sm text-destructive font-medium">Sync Error</p>
          <p className="text-sm text-destructive/80 mt-1">{integration.sync_error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-muted/50 rounded-lg p-3">
          <p className="text-xs text-muted-foreground">Last Synced</p>
          <p className="text-sm font-medium text-foreground mt-1">
            {formatDate(integration.last_synced_at)}
          </p>
        </div>
        <div className="bg-muted/50 rounded-lg p-3">
          <p className="text-xs text-muted-foreground">Total Items</p>
          <p className="text-sm font-medium text-foreground mt-1">{totalItems.toLocaleString()}</p>
        </div>
        {integration.stats &&
          Object.entries(integration.stats)
            .slice(0, 2)
            .map(([type, count]) => (
              <div key={type} className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground capitalize">{type}s</p>
                <p className="text-sm font-medium text-foreground mt-1">{count.toLocaleString()}</p>
              </div>
            ))}
      </div>

      {/* Endpoint Sync Buttons */}
      {providerConfig?.endpoints && (
        <div className="mt-6">
          <p className="text-xs text-muted-foreground mb-3">Sync Individual Endpoints</p>
          <div className="flex flex-wrap gap-2">
            {providerConfig.endpoints.map(endpoint => {
              const isEndpointSyncing = syncingEndpoint === endpoint;
              return (
                <Button
                  key={endpoint}
                  variant="outline"
                  size="sm"
                  onClick={() => onSyncEndpoint(endpoint)}
                  disabled={isSyncing || integration.sync_status === 'syncing' || isEndpointSyncing}
                  className="text-xs"
                >
                  <ArrowsClockwise
                    size={12}
                    weight="bold"
                    className={cn('mr-1', isEndpointSyncing && 'animate-spin')}
                  />
                  {endpoint}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 pt-6 border-t border-border flex items-center justify-between">
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
          <Trash size={14} weight="bold" className="mr-1" />
          Remove
        </Button>
        <Button onClick={onSync} disabled={isSyncing || integration.sync_status === 'syncing'}>
          <ArrowsClockwise
            size={16}
            weight="bold"
            className={cn(
              'mr-2',
              (isSyncing || integration.sync_status === 'syncing') && 'animate-spin'
            )}
          />
          Sync All Data
        </Button>
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
    <div className="bg-card rounded-xl border border-border p-6">
      <h3 className="text-lg font-semibold text-foreground mb-6">Add New Integration</h3>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Connected Entity Display */}
        <div className="p-4 rounded-lg bg-muted/50 border border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Buildings size={20} weight="duotone" className="text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Connected Business</p>
              <p className="font-medium text-foreground">{entity?.name || 'No entity connected'}</p>
            </div>
          </div>
        </div>

        {/* Provider Selection */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">Provider</label>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(PROVIDERS).map(([key, config]) => (
              <button
                key={key}
                type="button"
                onClick={() => setProvider(key as 'squarespace' | 'revolut')}
                className={cn(
                  'p-4 rounded-lg border-2 text-left transition-colors',
                  provider === key
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground'
                )}
              >
                <div className="flex items-center gap-3">
                  {config.icon}
                  <span className="font-medium text-foreground">{config.name}</span>
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
          </label>
          <Input
            placeholder={
              provider === 'squarespace'
                ? 'Enter your Squarespace site ID'
                : 'Enter your Revolut business ID'
            }
            value={externalAccountId}
            onChange={e => setExternalAccountId(e.target.value)}
          />
        </div>

        {/* Display Name */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Display Name (optional)
          </label>
          <Input
            placeholder="My Store"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
          />
        </div>

        {/* API Key */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">API Key</label>
          <div className="relative">
            <Input
              type={showApiKey ? 'text' : 'password'}
              placeholder="Enter your API key"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showApiKey ? <EyeSlash size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {provider === 'squarespace'
              ? 'Generate an API key from Squarespace Settings → Advanced → Developer API Keys'
              : 'Get your API key from Revolut Business Settings'}
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
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

  // Handle sync
  const handleSync = async (sourceId: string, endpoint?: string) => {
    setSyncingIds(prev => new Set([...prev, sourceId]));

    if (endpoint) {
      setSyncingEndpoints(prev => new Map(prev).set(sourceId, endpoint));
      toast.loading(`Syncing ${endpoint}...`, { id: `sync-${sourceId}-${endpoint}` });
    } else {
      toast.loading('Syncing all data...', { id: `sync-${sourceId}` });
    }

    try {
      const response = await triggerSync(sourceId, endpoint);
      if (response?.status != 'completed') {
        throw new Error('Sync did not complete successfully');
      }
      await fetchData();

      if (endpoint) {
        toast.success(`${endpoint} synced successfully`, { id: `sync-${sourceId}-${endpoint}` });
      } else {
        toast.success('Full sync completed successfully', { id: `sync-${sourceId}` });
      }
    } catch (error) {
      console.error('Failed to trigger sync:', error);
      const message = endpoint ? `Failed to sync ${endpoint}` : 'Failed to sync data';

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
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 lg:p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Integrations</h1>
            <p className="text-muted-foreground mt-1">
              Connect your external services to sync data automatically
            </p>
          </div>
          <Button onClick={() => setShowAddForm(!showAddForm)}>
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

        {/* Loading State */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <ArrowsClockwise size={32} weight="bold" className="animate-spin text-primary" />
          </div>
        ) : integrations.length === 0 && !showAddForm ? (
          /* Empty State */
          <div className="text-center py-20">
            <PlugsConnected size={48} weight="duotone" className="mx-auto text-muted-foreground" />
            <h3 className="text-lg font-semibold text-foreground mt-4">No integrations yet</h3>
            <p className="text-muted-foreground mt-2">
              Connect your Squarespace or Revolut account to start syncing data
            </p>
            <Button onClick={() => setShowAddForm(true)} className="mt-6">
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
      </div>
    </div>
  );
}
