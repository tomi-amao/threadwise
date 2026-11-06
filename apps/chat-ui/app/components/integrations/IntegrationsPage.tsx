/**
 * IntegrationsPage
 *
 * The sources your books are built from, as a grid of apps. Each connected source is a tile that
 * says whether it is healthy; clicking it opens a drawer with everything that can be done with it
 * (the open one is `?app=<source id>` in the URL). Providers not connected yet are tiles to
 * connect; hidden ones sit in a collapsed row and keep syncing. Talks to the agent from the
 * browser, as before, and polls every 15 seconds so progress shows up without a refresh.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { BookOpen } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
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
  saveMerchantKey,
  removeMerchantKey,
  setIntegrationHidden,
  type IntegrationSummary,
} from '~/lib/api/integrations';
import { SyncProgressToast } from '~/components/integrations/SyncProgressToast';
import { NormalizationProgressToast } from '~/components/integrations/NormalizationProgressToast';
import { IncompleteTransactionsModal } from '~/components/integrations/IncompleteTransactionsModal';
import { JournalGenerationModal } from '~/components/integrations/JournalGenerationModal';
import { AddIntegrationDrawer } from './AddIntegrationDrawer';
import { AppTile, ConnectTile } from './AppTile';
import { IntegrationCard } from './IntegrationCard';
import { BrandLogo } from './logos';
import { PROVIDERS, int, namesOf, needsYou, relativeTime, type ProviderKey } from './model';

export function IntegrationsPage() {
  const { entity } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [syncingEndpoints, setSyncingEndpoints] = useState<Map<string, string>>(new Map());
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set());
  // Revolut integrations whose Merchant key is being saved, checked or removed.
  const [merchantBusyIds, setMerchantBusyIds] = useState<Set<string>>(new Set());
  const [normalizingIds, setNormalizingIds] = useState<Set<string>>(new Set());
  const [reprocessingIds, setReprocessingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [hidingIds, setHidingIds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  // The provider whose connect tile was clicked, for the add form to start on.
  const [addProvider, setAddProvider] = useState<ProviderKey | undefined>(undefined);
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
  const handleSync = async (
    sourceId: string,
    endpoint?: string,
    forceFull = false,
    includeDrafts = false
  ) => {
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
      const response = await triggerSync(sourceId, endpoint, forceFull, includeDrafts);
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
      // No toast when the key works: the card's "Key works" chip says so. Only a problem gets one.
      const result = await validateApiKey(sourceId);
      await fetchData();
      if (!result) toast.error('The key could not be checked', { id: `validate-${sourceId}` });
      else if (result.status === 'valid') toast.dismiss(`validate-${sourceId}`);
      else
        toast.warning(`The key was not accepted: ${result.message}`, {
          id: `validate-${sourceId}`,
        });
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

  /** Run a Merchant key action for a Revolut integration, then refresh its card. */
  const withMerchantBusy = async (sourceId: string, action: () => Promise<void>) => {
    setMerchantBusyIds(prev => new Set([...prev, sourceId]));
    try {
      await action();
      await fetchData();
    } finally {
      setMerchantBusyIds(prev => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  };

  const handleSaveMerchantKey = (sourceId: string, apiKey: string) =>
    withMerchantBusy(sourceId, async () => {
      const result = await saveMerchantKey(sourceId, apiKey);
      if (!result) toast.error('The Merchant key could not be saved');
      else if (result.status === 'valid') toast.success(result.message);
      else toast.warning(`Merchant key saved, but Revolut did not accept it: ${result.message}`);
    });

  const handleCheckMerchantKey = (sourceId: string, merchantSourceId: string) =>
    withMerchantBusy(sourceId, async () => {
      const result = await validateApiKey(merchantSourceId);
      if (!result) toast.error('The Merchant key could not be checked');
      else if (result.status !== 'valid') toast.warning(`Merchant key rejected: ${result.message}`);
    });

  const handleRemoveMerchantKey = (sourceId: string) =>
    withMerchantBusy(sourceId, async () => {
      if (await removeMerchantKey(sourceId)) toast.success('Merchant key removed');
      else toast.error('The Merchant key could not be removed');
    });

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

  // Hide an integration on this page, or show it again. Only the page changes: it keeps syncing.
  const handleToggleHidden = async (integration: IntegrationSummary) => {
    const hide = !integration.hidden_at;
    setHidingIds(prev => new Set([...prev, integration.id]));
    try {
      const result = await setIntegrationHidden(integration.id, hide);
      if (result === undefined) {
        toast.error(hide ? 'Could not hide it' : 'Could not show it');
        return;
      }
      await fetchData();
      toast.success(
        hide ? 'Moved to Hidden. It stays connected and keeps syncing.' : 'Back with your apps'
      );
    } finally {
      setHidingIds(prev => {
        const next = new Set(prev);
        next.delete(integration.id);
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

  const attention = integrations.filter(needsYou).length;
  const shown = integrations.filter(i => !i.hidden_at);
  const hidden = integrations.filter(i => i.hidden_at);
  // Providers with nothing connected yet are offered as tiles to connect.
  const connected = new Set(integrations.map(i => i.provider));
  const connectable = (Object.keys(PROVIDERS) as ProviderKey[]).filter(p => !connected.has(p));

  // The open app is in the URL, so a link or a refresh lands on it.
  const openId = searchParams.get('app');
  const open = integrations.find(i => i.id === openId) ?? null;
  const setOpen = (id: string | null) =>
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (id) next.set('app', id);
        else next.delete('app');
        return next;
      },
      { replace: true }
    );
  const connect = (provider?: ProviderKey) => {
    setAddProvider(provider);
    setShowAddForm(true);
  };

  const handlersFor = (integration: IntegrationSummary) => ({
    onSync: (forceFull: boolean, includeDrafts?: boolean) =>
      handleSync(integration.id, undefined, forceFull, includeDrafts),
    onSyncEndpoint: (endpoint: string) => handleSync(integration.id, endpoint),
    onValidateApiKey: () => handleValidateApiKey(integration.id),
    onUpdateApiKey: (apiKey: string) => handleUpdateApiKey(integration.id, apiKey),
    onViewUncategorized: () =>
      setUncategorizedModalSource({
        id: integration.id,
        entityId: integration.entity_id ?? undefined,
      }),
    onLoadData: (mode: 'hard' | 'soft') => handleLoadData(integration.id, mode),
    onReprocessFailed: () => handleReprocessFailed(integration.id),
    onRemove: () => {
      setOpen(null);
      handleRemove(integration.id);
    },
    onToggleHidden: () => handleToggleHidden(integration),
    onSaveMerchantKey: (apiKey: string) => handleSaveMerchantKey(integration.id, apiKey),
    onCheckMerchantKey: () =>
      integration.merchant &&
      handleCheckMerchantKey(integration.id, integration.merchant.source_id),
    onRemoveMerchantKey: () => handleRemoveMerchantKey(integration.id),
  });
  const stateFor = (integration: IntegrationSummary) => ({
    isSyncing: syncingIds.has(integration.id),
    syncingEndpoint: syncingEndpoints.get(integration.id) || null,
    isValidatingApiKey: validatingIds.has(integration.id),
    isNormalizing: normalizingIds.has(integration.id),
    isReprocessing: reprocessingIds.has(integration.id),
    isRemoving: removingIds.has(integration.id),
    isTogglingHidden: hidingIds.has(integration.id),
    isBusyMerchantKey: merchantBusyIds.has(integration.id),
  });
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
        description="Your stores, payment accounts and banks. Each syncs on its own and shows when it needs you; open one to sync it or fix it."
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
              caption="keys, out-of-date syncs, failed events, uncategorised"
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
        ) : (
          <>
            {shown.length > 0 && (
              <section aria-labelledby="apps-connected" className="space-y-3">
                <h2 id="apps-connected" className="eyebrow">
                  Your apps
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map(integration => (
                    <li key={integration.id}>
                      <AppTile integration={integration} onOpen={() => setOpen(integration.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {connectable.length > 0 && (
              <section aria-labelledby="apps-add" className="space-y-3 pt-2">
                <h2 id="apps-add" className="eyebrow">
                  {integrations.length === 0 ? 'Connect your first app' : 'Add an app'}
                </h2>
                {integrations.length === 0 && (
                  <p className="text-[15px] text-text-2">
                    Shopify, Squarespace, PayPal and Revolut each bring in what the books are built
                    from: orders, payments and bank lines.
                  </p>
                )}
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {connectable.map(provider => (
                    <li key={provider}>
                      <ConnectTile provider={provider} onConnect={() => connect(provider)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {hidden.length > 0 && (
              <details className="group rounded-2xl border bg-row px-5 py-4">
                <summary className="cursor-pointer list-none rounded-sm text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="eyebrow">Hidden</span>{' '}
                  <span className="text-text-2">
                    {int(hidden.length)} {hidden.length === 1 ? 'app' : 'apps'}, still connected and
                    syncing
                  </span>
                </summary>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {hidden.map(integration => (
                    <li key={integration.id}>
                      <AppTile integration={integration} onOpen={() => setOpen(integration.id)} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>

      <Drawer
        open={!!open}
        onOpenChange={o => !o && setOpen(null)}
        eyebrow={open ? (namesOf(open).account ?? 'Integration') : 'Integration'}
        title={
          open ? (
            <span className="flex items-center gap-3">
              <BrandLogo provider={open.provider} size="sm" />
              {namesOf(open).name}
            </span>
          ) : (
            ''
          )
        }
        description={open ? `What you can do with ${namesOf(open).name}` : undefined}
        className="w-[min(640px,100vw)]"
      >
        {open && (
          <IntegrationCard
            key={open.id}
            bare
            integration={open}
            handlers={handlersFor(open)}
            state={stateFor(open)}
          />
        )}
      </Drawer>

      <AddIntegrationDrawer
        open={showAddForm}
        provider={addProvider}
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
