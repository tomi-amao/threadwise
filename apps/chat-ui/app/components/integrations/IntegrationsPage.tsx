/**
 * IntegrationsPage
 *
 * The sources your books are built from. Each connected source shows whether it is healthy and
 * what needs a person; the routine (sync, load data) is a button away. Talks to the agent from
 * the browser, as before, and polls every 15 seconds so progress shows up without a refresh.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { BookOpen, Plus } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { EmptyState } from '~/components/ui/empty-state';
import { CompactHeader } from '~/components/ui/page-header';
import { Stat, StatStrip } from '~/components/ui/stat-strip';
import { useAuth } from '~/providers/AuthProvider';
import {
  getIntegrationsSummary,
  triggerSync,
  triggerNormalization,
  validateApiKey,
  reprocessFailedEvents,
  deleteExternalSource,
  type IntegrationSummary,
} from '~/lib/api/integrations';
import { SyncProgressToast } from '~/components/integrations/SyncProgressToast';
import { NormalizationProgressToast } from '~/components/integrations/NormalizationProgressToast';
import { IncompleteTransactionsModal } from '~/components/integrations/IncompleteTransactionsModal';
import { JournalGenerationModal } from '~/components/integrations/JournalGenerationModal';
import { AddIntegrationDrawer } from './AddIntegrationDrawer';
import { IntegrationCard } from './IntegrationCard';
import { int, relativeTime } from './model';

export function IntegrationsPage() {
  const { entity } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
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

  // The Zoho Calendar OAuth callback redirects back here with a
  // ?zoho_calendar= result — this app never sees the OAuth flow itself
  // (it's entirely backend-driven), so this is the only place a toast for
  // it can be shown. The params are stripped right after so a page refresh
  // doesn't re-show the toast.
  useEffect(() => {
    const result = searchParams.get('zoho_calendar');
    if (!result) return;

    if (result === 'connected') {
      toast.success('Zoho Calendar connected');
      fetchData();
    } else if (result === 'error') {
      const reason = searchParams.get('reason') || 'unknown_error';
      toast.error(`Failed to connect Zoho Calendar (${reason})`);
    }

    const next = new URLSearchParams(searchParams);
    next.delete('zoho_calendar');
    next.delete('reason');
    setSearchParams(next, { replace: true });
    // Deliberately empty deps — this consumes a one-time redirect result on
    // mount, not something that should re-run when fetchData/searchParams
    // identity changes.
  }, []);

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

  // Handle sync. forceFull=false (default) only fetches records updated
  // since each endpoint's last successful sync; true re-fetches full
  // history, ignoring any watermark.
  const handleSync = async (sourceId: string, endpoint?: string, forceFull = false) => {
    setSyncingIds(prev => new Set([...prev, sourceId]));

    setActiveSyncSource({ id: sourceId, name: '' }); // Name can be set if needed
    const syncKind = forceFull ? 'full resync' : 'sync';
    if (endpoint) {
      setSyncingEndpoints(prev => new Map(prev).set(sourceId, endpoint));
      toast.loading(`Running ${syncKind} for ${endpoint}...`, {
        id: `sync-${sourceId}-${endpoint}`,
      });
    } else {
      toast.loading(`Running ${syncKind} for all data...`, { id: `sync-${sourceId}` });
    }

    try {
      const response = await triggerSync(sourceId, endpoint, forceFull);
      if (response?.status != 'triggered') {
        throw new Error('Sync did not trigger successfully');
      }
      await fetchData();

      if (endpoint) {
        toast.success(`${endpoint} triggered successfully`, { id: `sync-${sourceId}-${endpoint}` });
      } else {
        toast.success(
          forceFull ? 'Full resync triggered successfully' : 'Sync triggered successfully',
          { id: `sync-${sourceId}` }
        );
      }
    } catch (error) {
      console.error('Failed to trigger sync:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isInngestDown =
        errorMsg.includes('never received response') || errorMsg.includes('sending events');
      const message = isInngestDown
        ? 'Sync server (Inngest) is not running — start it and try again'
        : endpoint
          ? `Failed to trigger ${endpoint}`
          : 'Failed to trigger sync';
      const toastId = endpoint ? `sync-${sourceId}-${endpoint}` : `sync-${sourceId}`;
      toast.error(message, { id: toastId, duration: isInngestDown ? 8000 : 4000 });
      setActiveSyncSource(null);
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

  const attention = integrations.filter(
    i =>
      i.sync_status === 'error' ||
      i.api_key_status === 'invalid' ||
      i.api_key_status === 'expired' ||
      i.failed_events_count > 0 ||
      i.uncategorized_transactions_count > 0
  ).length;
  const items = integrations.reduce(
    (t, i) => t + (i.stats ? Object.values(i.stats).reduce((a, b) => a + b, 0) : 0),
    0
  );
  const latest = integrations
    .map(i => i.last_synced_at)
    .filter((d): d is string => !!d)
    .sort()
    .pop();

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Integrations"
        title={
          <>
            Where the data <em>comes from.</em>
          </>
        }
        description="Connect a store, a payment account or a bank. Each syncs on its own and shows when it needs you."
        actions={
          <>
            {entity?.id && integrations.length > 0 && (
              <Button
                variant="outline"
                onClick={() => setJournalModalSource({ entityId: entity.id })}
              >
                <BookOpen size={16} weight="light" aria-hidden /> Generate journals
              </Button>
            )}
            <Button onClick={() => setShowAddForm(true)}>
              <Plus size={16} weight="bold" aria-hidden /> Add integration
            </Button>
          </>
        }
      />

      <div className="mx-auto max-w-[1100px] space-y-4 px-4 sm:px-6 lg:px-8">
        {integrations.length > 0 && (
          <StatStrip>
            <Stat
              label="Connected"
              value={int(integrations.length)}
              title="Sources"
              caption="stores, payments, banks"
            />
            <Stat
              label="Items"
              value={int(items)}
              title="Synced so far"
              caption="orders, products, transactions"
            />
            <Stat
              label="Needs you"
              tone={attention > 0 ? 'negative' : 'default'}
              value={int(attention)}
              title={
                attention === 0
                  ? 'All healthy'
                  : attention === 1
                    ? 'Source to look at'
                    : 'Sources to look at'
              }
              caption="keys, failed events, uncategorised"
            />
            <Stat
              label="Last sync"
              value={relativeTime(latest ?? null)}
              title="Most recent"
              caption="across all sources"
            />
          </StatStrip>
        )}

        {loading ? (
          <p role="status" className="py-16 text-center text-[15px] text-text-2">
            Loading your integrations…
          </p>
        ) : integrations.length === 0 ? (
          <div className="overflow-hidden rounded-2xl border bg-row">
            <EmptyState
              eyebrow="Nothing connected"
              title="Connect your first source."
              description="Shopify, Squarespace, PayPal and Revolut each bring in what the books are built from: orders, payments and bank lines."
              action={
                <Button size="sm" onClick={() => setShowAddForm(true)}>
                  <Plus size={14} weight="bold" aria-hidden /> Add integration
                </Button>
              }
            />
          </div>
        ) : (
          <div className="space-y-4">
            {integrations.map(integration => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                handlers={{
                  onSync: forceFull => handleSync(integration.id, undefined, forceFull),
                  onSyncEndpoint: endpoint => handleSync(integration.id, endpoint),
                  onValidateApiKey: () => handleValidateApiKey(integration.id),
                  onUpdateApiKey: apiKey => handleUpdateApiKey(integration.id, apiKey),
                  onViewUncategorized: () =>
                    setUncategorizedModalSource({
                      id: integration.id,
                      entityId: integration.entity_id ?? undefined,
                    }),
                  onLoadData: mode => handleLoadData(integration.id, mode),
                  onReprocessFailed: () => handleReprocessFailed(integration.id),
                  onRemove: () => handleRemove(integration.id),
                }}
                state={{
                  isSyncing: syncingIds.has(integration.id),
                  syncingEndpoint: syncingEndpoints.get(integration.id) || null,
                  isValidatingApiKey: validatingIds.has(integration.id),
                  isNormalizing: normalizingIds.has(integration.id),
                  isReprocessing: reprocessingIds.has(integration.id),
                  isRemoving: removingIds.has(integration.id),
                }}
              />
            ))}
          </div>
        )}
      </div>

      <AddIntegrationDrawer
        open={showAddForm}
        onClose={() => setShowAddForm(false)}
        onAdded={() => {
          setShowAddForm(false);
          fetchData();
        }}
      />

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

      {journalModalSource && (
        <JournalGenerationModal
          isOpen={true}
          entityId={journalModalSource.entityId}
          onClose={() => {
            setJournalModalSource(null);
            fetchData();
          }}
        />
      )}
    </div>
  );
}
