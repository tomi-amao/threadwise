/** Integrations view model: what each provider is, and the wording for its state. */

import {
  Bank,
  Buildings,
  CalendarBlank,
  Coins,
  Cube,
  FileText,
  Package,
  ShoppingBag,
  ShoppingCart,
  Storefront,
  UserCircle,
} from 'phosphor-react';
import type { ChipTone } from '~/components/ui/chip';

export type ProviderKey = 'squarespace' | 'revolut' | 'paypal' | 'shopify' | 'zoho_calendar';
export type CredentialType = 'key' | 'compound' | 'oauth';

export interface Provider {
  name: string;
  icon: React.ReactNode;
  description: string;
  endpoints: string[];
  credential: CredentialType;
  /** What the account field is called, and its placeholder. */
  accountLabel: string;
  accountPlaceholder: string;
  /** Where to find the credentials. */
  keyHelp: string;
}

const ICON = { size: 22, weight: 'light' as const, 'aria-hidden': true };

export const PROVIDERS: Record<ProviderKey, Provider> = {
  shopify: {
    name: 'Shopify',
    icon: <ShoppingBag {...ICON} />,
    description: 'Products, orders, customers, inventory and card fees.',
    endpoints: ['products', 'orders', 'customers', 'inventory', 'balance_transactions'],
    credential: 'compound',
    accountLabel: 'Shop domain',
    accountPlaceholder: 'mystore.myshopify.com',
    keyHelp: 'Client ID and Client Secret: Shopify Partners, Apps, App setup.',
  },
  squarespace: {
    name: 'Squarespace',
    icon: <Storefront {...ICON} />,
    description: 'Products, orders, inventory, profiles and transactions.',
    endpoints: ['products', 'orders', 'inventory', 'profiles', 'transactions'],
    credential: 'key',
    accountLabel: 'Site ID',
    accountPlaceholder: 'Your Squarespace site ID',
    keyHelp: 'Squarespace Settings, Advanced, Developer API Keys.',
  },
  paypal: {
    name: 'PayPal',
    icon: <Coins {...ICON} />,
    description: 'Transactions and balances from PayPal Business.',
    endpoints: ['transactions'],
    credential: 'compound',
    accountLabel: 'Account email',
    accountPlaceholder: 'The email on your PayPal account',
    keyHelp: 'Client ID and Secret: PayPal Developer Dashboard, REST API apps.',
  },
  revolut: {
    name: 'Revolut',
    icon: <Bank {...ICON} />,
    description: 'Transactions and accounts from Revolut Business.',
    endpoints: ['transactions', 'accounts'],
    credential: 'key',
    accountLabel: 'Business ID',
    accountPlaceholder: 'Your Revolut business ID',
    keyHelp: 'Revolut Business, Settings, API.',
  },
  zoho_calendar: {
    name: 'Zoho Calendar',
    icon: <CalendarBlank {...ICON} />,
    description:
      'Pulls your events in, and puts tax deadlines and collection launch dates in a "ThreadWise Deadlines" calendar.',
    endpoints: ['calendar_events', 'tax_deadlines', 'collection_launches'],
    credential: 'oauth',
    accountLabel: '',
    accountPlaceholder: '',
    keyHelp: '',
  },
};

export const providerOf = (key: string): Provider | undefined => PROVIDERS[key as ProviderKey];

const E = { size: 14, weight: 'light' as const, 'aria-hidden': true };
export const ENDPOINT_ICON: Record<string, React.ReactNode> = {
  products: <Package {...E} />,
  orders: <ShoppingCart {...E} />,
  inventory: <Cube {...E} />,
  store_pages: <FileText {...E} />,
  profiles: <UserCircle {...E} />,
  customers: <UserCircle {...E} />,
  transactions: <Coins {...E} />,
  balance_transactions: <Coins {...E} />,
  accounts: <Buildings {...E} />,
  calendar_events: <CalendarBlank {...E} />,
  tax_deadlines: <CalendarBlank {...E} />,
  collection_launches: <CalendarBlank {...E} />,
};

export const SYNC_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  idle: { label: 'Idle', tone: 'plain' },
  syncing: { label: 'Syncing', tone: 'active' },
  completed: { label: 'Up to date', tone: 'done' },
  error: { label: 'Sync failed', tone: 'negative' },
};

export const KEY_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  pending: { label: 'Key not checked', tone: 'draft' },
  valid: { label: 'Key works', tone: 'done' },
  invalid: { label: 'Key rejected', tone: 'negative' },
  expired: { label: 'Key expired', tone: 'negative' },
};

export function relativeTime(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const int = (n: number) => new Intl.NumberFormat('en-GB').format(n);
export const prettyEndpoint = (e: string) => e.replace(/_/g, ' ');
