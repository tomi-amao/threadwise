/**
 * IntegrationCard: one connected source, everything that can be done with it. The top says
 * whether it is healthy; anything that needs a person (a rejected key, failed events,
 * uncategorised transactions) is a callout with the action beside it; the bottom is the routine:
 * sync, load data, hide, remove. A Revolut card also holds the Merchant key, which syncs the
 * invoices sent from Revolut (see MerchantKeySection).
 *
 * The Integrations page shows it inside a drawer, opened from the source's tile (`bare`: the
 * drawer's title already names it, so the card leaves out its own logo and name).
 */

import { useState } from 'react';
import {
  ArrowsClockwise,
  Database,
  Eye,
  EyeSlash,
  Receipt,
  Sparkle,
  Trash,
  Warning,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { PasswordInput } from '~/components/ui/password-input';
import { SplitMenu } from '~/components/ui/split-menu';
import { ConfirmRemove } from '~/components/collections/use-collection-action';
import { ZOHO_CALENDAR_CONNECT_PATH, type IntegrationSummary } from '~/lib/api/integrations';
import { cn } from '~/lib/utils';
import {
  ENDPOINT_ICON,
  KEY_STATUS,
  MERCHANT_ENDPOINT,
  MERCHANT_KEY_HELP,
  int,
  prettyEndpoint,
  providerOf,
  relativeTime,
  namesOf,
  staleLabel,
  statusOf,
} from './model';
import { BrandLogo } from './logos';

export interface CardHandlers {
  onSync: (forceFull: boolean, includeDrafts?: boolean) => void;
  onSyncEndpoint: (endpoint: string) => void;
  onValidateApiKey: () => void;
  onUpdateApiKey: (apiKey: string) => void;
  onLoadData: (mode: 'hard' | 'soft') => void;
  onReprocessFailed: () => void;
  onRemove: () => void;
  onViewUncategorized: () => void;
  /** Hide it on the page, or show it again (it keeps syncing either way). */
  onToggleHidden?: () => void;
  /** Revolut only: add or replace, check and remove the Merchant key. */
  onSaveMerchantKey?: (apiKey: string) => void;
  onCheckMerchantKey?: () => void;
  onRemoveMerchantKey?: () => void;
}

export interface CardState {
  isSyncing: boolean;
  syncingEndpoint: string | null;
  isValidatingApiKey: boolean;
  isNormalizing: boolean;
  isReprocessing: boolean;
  isRemoving: boolean;
  isTogglingHidden?: boolean;
  /** Saving, checking or removing the Merchant key. */
  isBusyMerchantKey?: boolean;
}

function Callout({
  tone,
  title,
  children,
  action,
}: {
  tone: 'attention' | 'negative';
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3.5',
        tone === 'negative'
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-ring/40 bg-accent-tint'
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <Warning
          size={18}
          weight="light"
          aria-hidden
          className={cn(
            'mt-0.5 shrink-0',
            tone === 'negative' ? 'text-destructive' : 'text-accent-text'
          )}
        />
        <div>
          <p className={cn('text-[15px] font-medium', tone === 'negative' && 'text-destructive')}>
            {title}
          </p>
          <p className="mt-0.5 text-[14px] text-text-2">{children}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function CredentialsForm({
  provider,
  onSave,
  onCancel,
}: {
  provider: string;
  onSave: (payload: string) => void;
  onCancel: () => void;
}) {
  const config = providerOf(provider);
  const compound = config?.credential === 'compound';
  const [key, setKey] = useState('');
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const ready = compound ? id.trim() && secret.trim() : key.trim();

  return (
    <form
      className="space-y-4 rounded-xl border bg-background p-4"
      onSubmit={e => {
        e.preventDefault();
        if (!ready) return;
        onSave(
          compound
            ? JSON.stringify(
                provider === 'shopify'
                  ? { client_id: id.trim(), client_secret: secret.trim() }
                  : { client_id: id.trim(), secret: secret.trim() }
              )
            : key.trim()
        );
      }}
    >
      <p className="text-[15px] font-medium">
        {compound ? 'Update credentials' : 'Update API key'}
      </p>
      {compound ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID">
            <Input value={id} onChange={e => setId(e.target.value)} autoComplete="off" />
          </Field>
          <Field label={provider === 'shopify' ? 'Client secret' : 'Secret'}>
            <PasswordInput
              value={secret}
              onChange={e => setSecret(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
      ) : (
        <Field label="API key">
          <PasswordInput value={key} onChange={e => setKey(e.target.value)} autoComplete="off" />
        </Field>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The Merchant key of a Revolut integration. The invoices sent from Revolut are Merchant API
 * payment requests, and that API has its own secret key; the agent keeps it as its own row and
 * the Revolut sync uses it for the payment_requests endpoint.
 */
function MerchantKeySection({
  integration,
  handlers,
  busy,
}: {
  integration: IntegrationSummary;
  handlers: CardHandlers;
  busy: boolean;
}) {
  const merchant = integration.merchant ?? null;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState('');
  const status = merchant
    ? (KEY_STATUS[merchant.api_key_status] ?? KEY_STATUS.pending)
    : { label: 'No Merchant key', tone: 'plain' as const };

  return (
    <section
      aria-label="Invoices from Revolut"
      className="space-y-3 rounded-xl border bg-background p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <Receipt size={18} weight="light" aria-hidden className="mt-0.5 shrink-0 text-text-2" />
          <div>
            <h3 className="text-[15px] font-medium">Invoices</h3>
            <p className="mt-0.5 text-[14px] text-text-2">
              {merchant
                ? 'The invoices you send from Revolut are kept on the Invoices page and matched to the payments that settle them.'
                : 'Add your Merchant key to keep the invoices you send from Revolut on the Invoices page.'}
            </p>
          </div>
        </div>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>

      {merchant?.api_key_status === 'invalid' && merchant.api_key_error && (
        <p className="text-[14px] text-destructive">{merchant.api_key_error}</p>
      )}

      {editing ? (
        <form
          className="space-y-3"
          onSubmit={e => {
            e.preventDefault();
            if (!key.trim()) return;
            handlers.onSaveMerchantKey?.(key.trim());
            setKey('');
            setEditing(false);
          }}
        >
          <Field label="Merchant secret key" hint={MERCHANT_KEY_HELP}>
            <PasswordInput value={key} onChange={e => setKey(e.target.value)} autoComplete="off" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!key.trim() || busy}>
              Save and check
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            {merchant ? 'Replace key' : 'Add Merchant key'}
          </Button>
          {merchant && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={handlers.onCheckMerchantKey}
                aria-label="Check the Merchant key"
              >
                <ArrowsClockwise size={13} aria-hidden className={cn(busy && 'animate-spin')} />
                {busy ? 'Checking…' : 'Check'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-text-2 hover:text-destructive"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Remove key
              </Button>
            </>
          )}
        </div>
      )}

      <ConfirmRemove
        open={confirming}
        title="Remove the Merchant key?"
        description="Invoices already synced from Revolut stay. New ones stop coming in until you add a key again."
        confirmLabel="Remove key"
        busy={busy}
        error={null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          handlers.onRemoveMerchantKey?.();
          setConfirming(false);
        }}
      />
    </section>
  );
}

export function IntegrationCard({
  integration,
  handlers,
  state,
  bare = false,
}: {
  integration: IntegrationSummary;
  handlers: CardHandlers;
  state: CardState;
  /** Inside the drawer: no border of its own, and no logo or name (the drawer has them). */
  bare?: boolean;
}) {
  const config = providerOf(integration.provider);
  const oauth = config?.credential === 'oauth';
  const [editingKey, setEditingKey] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const total = integration.stats ? Object.values(integration.stats).reduce((a, b) => a + b, 0) : 0;
  const syncActive = state.isSyncing || integration.sync_status === 'syncing';
  // Out of date (no sync for two weeks) unless it is syncing or failed: see statusOf.
  const sync = statusOf(integration);
  const stale = sync.stale;
  const key = KEY_STATUS[integration.api_key_status ?? 'pending'] ?? KEY_STATUS.pending;
  // The provider is the title ("Shopify"); the shop or account it is connected to goes under it.
  const { name, account } = namesOf(integration);
  const hidden = !!integration.hidden_at;
  const topStats = integration.stats ? Object.entries(integration.stats).slice(0, 2) : [];

  return (
    <article
      aria-label={account ? `${name}, ${account}` : name}
      className={cn(
        !bare && 'rounded-2xl border bg-card transition-colors',
        !bare && (syncActive ? 'border-ring' : 'border-border')
      )}
    >
      <div className={cn('space-y-5', !bare && 'p-6')}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          {!bare && (
            <div className="flex items-center gap-4">
              <BrandLogo provider={integration.provider} />
              <div>
                <h2 className="font-serif text-[26px] leading-tight tracking-[-0.02em]">{name}</h2>
                {account && <p className="text-[14px] text-text-2">{account}</p>}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Chip
              tone={sync.tone}
              dot
              title={
                stale && integration.last_synced_at
                  ? staleLabel(integration.last_synced_at)
                  : undefined
              }
            >
              {sync.label}
            </Chip>
            <Chip tone={key.tone}>{key.label}</Chip>
            <Button
              variant="outline"
              size="sm"
              disabled={state.isValidatingApiKey}
              onClick={handlers.onValidateApiKey}
              aria-label={`Check the ${name} connection`}
            >
              <ArrowsClockwise
                size={13}
                aria-hidden
                className={cn(state.isValidatingApiKey && 'animate-spin')}
              />
              {state.isValidatingApiKey ? 'Checking…' : 'Check'}
            </Button>
          </div>
        </div>

        {integration.api_key_status === 'invalid' && integration.api_key_error && (
          <Callout
            tone="attention"
            title={oauth ? 'Connection issue' : 'API key issue'}
            action={
              oauth ? (
                <a
                  href={ZOHO_CALENDAR_CONNECT_PATH}
                  className="text-[14px] text-accent-text underline underline-offset-4 hover:text-foreground"
                >
                  Reconnect with Zoho
                </a>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setEditingKey(true)}>
                  {config?.credential === 'compound' ? 'Update credentials' : 'Update API key'}
                </Button>
              )
            }
          >
            {integration.api_key_error}
          </Callout>
        )}

        {!oauth && editingKey && (
          <CredentialsForm
            provider={integration.provider}
            onCancel={() => setEditingKey(false)}
            onSave={payload => {
              handlers.onUpdateApiKey(payload);
              setEditingKey(false);
            }}
          />
        )}

        {integration.sync_error && (
          <Callout tone="negative" title="Sync error">
            {integration.sync_error}
          </Callout>
        )}

        {integration.failed_events_count > 0 && (
          <Callout
            tone="attention"
            title={`${integration.failed_events_count} failed ${integration.failed_events_count === 1 ? 'event' : 'events'}`}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={handlers.onReprocessFailed}
                disabled={state.isReprocessing || state.isSyncing}
              >
                <ArrowsClockwise
                  size={13}
                  aria-hidden
                  className={cn(state.isReprocessing && 'animate-spin')}
                />
                {state.isReprocessing ? 'Retrying…' : 'Retry failed events'}
              </Button>
            }
          >
            Some events did not process. Retrying runs them again.
          </Callout>
        )}

        {integration.uncategorized_transactions_count > 0 && (
          <Callout
            tone="attention"
            title={`${integration.uncategorized_transactions_count} uncategorised ${integration.uncategorized_transactions_count === 1 ? 'transaction' : 'transactions'}`}
            action={
              <Button variant="outline" size="sm" onClick={handlers.onViewUncategorized}>
                <Sparkle size={13} aria-hidden /> Review and categorise
              </Button>
            }
          >
            No expense category yet, so no journal can be written for them.
          </Callout>
        )}

        <dl className={cn('grid grid-cols-2 gap-3', !bare && 'lg:grid-cols-4')}>
          <div className="rounded-xl border bg-background px-4 py-3">
            <dt className="eyebrow">Last sync</dt>
            <dd
              className={cn(
                'mt-1 font-serif text-[22px] tabular-nums',
                stale && 'text-accent-text'
              )}
            >
              {relativeTime(integration.last_synced_at)}
            </dd>
            {stale && integration.last_synced_at && (
              <dd className="text-[13px] text-accent-text">
                {staleLabel(integration.last_synced_at)}: sync to bring it up to date
              </dd>
            )}
          </div>
          {[
            ['Items', int(total)],
            ...topStats.map(([type, count]) => [prettyEndpoint(type), int(count)]),
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border bg-background px-4 py-3">
              <dt className="eyebrow">{label}</dt>
              <dd className="mt-1 font-serif text-[22px] tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        {config?.endpoints && (
          <div>
            <h3 className="eyebrow">Sync one thing</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {config.endpoints.map(endpoint => {
                const busy = state.syncingEndpoint === endpoint;
                const stat = integration.stats?.[endpoint];
                const last = integration.endpoint_sync_state?.[endpoint];
                const failed = last?.last_run_status === 'error';
                const needsKey = endpoint === MERCHANT_ENDPOINT && !integration.merchant;
                return (
                  <button
                    key={endpoint}
                    type="button"
                    onClick={() => handlers.onSyncEndpoint(endpoint)}
                    disabled={syncActive || busy || needsKey}
                    title={
                      needsKey
                        ? 'Add a Merchant key below to sync the invoices you send from Revolut'
                        : last
                          ? `Last synced ${relativeTime(last.last_synced_at)}${failed ? `. Last attempt failed: ${last.last_run_error || 'unknown error'}` : ''}`
                          : 'Never synced on its own: the next sync fetches the full history'
                    }
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                      busy ? 'border-ring bg-accent-tint' : 'border-border-strong hover:border-ring'
                    )}
                  >
                    <span className="text-text-2">
                      {busy ? (
                        <ArrowsClockwise size={14} aria-hidden className="animate-spin" />
                      ) : (
                        ENDPOINT_ICON[endpoint]
                      )}
                    </span>
                    <span className="capitalize">{prettyEndpoint(endpoint)}</span>
                    {stat !== undefined && (
                      <span className="font-mono text-[12px] tabular-nums text-text-2">
                        {int(stat)}
                      </span>
                    )}
                    {failed && !busy && (
                      <span
                        className="size-1.5 rounded-full bg-destructive"
                        role="img"
                        aria-label="Last attempt failed"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {integration.provider === 'revolut' && (
          <MerchantKeySection
            integration={integration}
            handlers={handlers}
            busy={!!state.isBusyMerchantKey}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-text-2 hover:text-destructive"
              disabled={state.isRemoving}
              onClick={() => setConfirmingRemove(true)}
            >
              <Trash size={14} aria-hidden /> {state.isRemoving ? 'Removing…' : 'Remove'}
            </Button>
            {handlers.onToggleHidden && (
              <Button
                variant="ghost"
                size="sm"
                className="text-text-2"
                disabled={state.isTogglingHidden}
                onClick={handlers.onToggleHidden}
                title={
                  hidden
                    ? 'Put it back with your other apps'
                    : 'Move it to Hidden on this page. It stays connected and keeps syncing.'
                }
              >
                {hidden ? <Eye size={14} aria-hidden /> : <EyeSlash size={14} aria-hidden />}
                {hidden ? 'Show' : 'Hide'}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(integration.sync_status === 'completed' || total > 0) && (
              <SplitMenu
                variant="outline"
                icon={<Database size={15} aria-hidden />}
                label="Load data"
                busyLabel="Loading…"
                busy={state.isNormalizing}
                disabled={syncActive || state.isNormalizing}
                onPrimary={() => handlers.onLoadData('soft')}
                items={[
                  {
                    label: 'Soft load',
                    tag: 'Default',
                    description: 'Only processes new or pending events. Safe to re-run.',
                    onSelect: () => handlers.onLoadData('soft'),
                  },
                  {
                    label: 'Hard load',
                    tag: 'Resets',
                    description: 'Resets every event to pending and reprocesses from scratch.',
                    onSelect: () => handlers.onLoadData('hard'),
                  },
                ]}
              />
            )}
            <SplitMenu
              icon={
                <ArrowsClockwise
                  size={15}
                  aria-hidden
                  className={cn(syncActive && 'animate-spin')}
                />
              }
              label="Sync all data"
              busyLabel="Syncing…"
              busy={syncActive}
              disabled={syncActive}
              onPrimary={() => handlers.onSync(false)}
              items={[
                {
                  label: 'Sync',
                  tag: 'Default',
                  description:
                    'Fetches only what changed since the last sync. Fast, safe to re-run.',
                  onSelect: () => handlers.onSync(false),
                },
                {
                  label: 'Full resync',
                  tag: 'Resets',
                  description:
                    'Ignores the sync watermark and re-fetches full history. Use if data looks incomplete or was corrected later.',
                  onSelect: () => handlers.onSync(true),
                },
                ...(integration.provider === 'shopify'
                  ? [
                      {
                        label: 'Sync with drafts',
                        description:
                          'Also brings in draft products, which are left out otherwise. Fetches all products again; orders and the rest stay incremental.',
                        onSelect: () => handlers.onSync(false, true),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
      </div>

      <ConfirmRemove
        open={confirmingRemove}
        title={`Remove ${name}?`}
        description="This deletes everything synced from it and cannot be undone."
        confirmLabel="Remove integration"
        busy={state.isRemoving}
        error={null}
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => {
          handlers.onRemove();
          setConfirmingRemove(false);
        }}
      />
    </article>
  );
}
