/**
 * AppTile and ConnectTile: the Integrations page as a grid of apps. A tile shows a connected
 * source at a glance (its logo, the account, its most pressing status, the last sync) and opens
 * its detail, with everything that can be done with it. A connect tile starts connecting a
 * provider that is not connected yet.
 */

import { ArrowRight, Plus } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import type { IntegrationSummary } from '~/lib/api/integrations';
import { cn } from '~/lib/utils';
import { BrandLogo } from './logos';
import {
  PROVIDERS,
  namesOf,
  relativeTime,
  staleLabel,
  statusOf,
  tileStatusOf,
  type ProviderKey,
} from './model';

const tileClass =
  'group flex h-full w-full flex-col gap-4 rounded-2xl border bg-card p-5 text-left transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AppTile({
  integration,
  onOpen,
}: {
  integration: IntegrationSummary;
  onOpen: () => void;
}) {
  const { name, account } = namesOf(integration);
  const status = tileStatusOf(integration);
  const { stale } = statusOf(integration);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(tileClass, integration.sync_status === 'syncing' && 'border-ring')}
    >
      {/* The name comes first, so it starts the tile's accessible name ("Shopify Atelier Shop Up
          to date ..."); `order` keeps the logo and status on top. */}
      <span className="order-2 min-w-0">
        <span className="block font-serif text-[22px] leading-tight tracking-[-0.02em]">
          {name}
        </span>
        {account && <span className="block truncate text-[14px] text-text-2">{account}</span>}
      </span>
      <span className="order-1 flex items-start justify-between gap-3">
        <BrandLogo provider={integration.provider} />
        <Chip tone={status.tone} dot>
          {status.label}
        </Chip>
      </span>
      <span className={cn('order-3 mt-auto text-[13px] text-text-2', stale && 'text-accent-text')}>
        {stale && integration.last_synced_at
          ? staleLabel(integration.last_synced_at)
          : `Last sync: ${relativeTime(integration.last_synced_at)}`}
      </span>
    </button>
  );
}

export function ConnectTile({
  provider,
  onConnect,
}: {
  provider: ProviderKey;
  onConnect: () => void;
}) {
  const config = PROVIDERS[provider];
  return (
    <button type="button" onClick={onConnect} className={cn(tileClass, 'bg-background')}>
      <span className="flex items-start justify-between gap-3">
        <BrandLogo provider={provider} />
        <span className="inline-flex items-center gap-1 text-[13px] text-accent-text">
          <Plus size={12} weight="bold" aria-hidden /> Connect
        </span>
      </span>
      <span className="min-w-0">
        <span className="block font-serif text-[22px] leading-tight tracking-[-0.02em]">
          {config.name}
        </span>
        <span className="mt-1 line-clamp-2 block text-[14px] text-text-2">
          {config.description}
        </span>
      </span>
      <span className="mt-auto inline-flex items-center gap-1 text-[13px] text-text-2 group-hover:text-foreground">
        Set it up <ArrowRight size={12} aria-hidden />
      </span>
    </button>
  );
}
