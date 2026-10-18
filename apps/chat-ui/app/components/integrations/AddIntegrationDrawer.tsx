/**
 * AddIntegrationDrawer: connect a new source. Pick the provider, say which account, give it its
 * credentials. Zoho Calendar is different: it signs in through Zoho, so there is nothing to type.
 */

import { useState } from 'react';
import { CalendarBlank, Warning } from 'phosphor-react';
import { Button, buttonVariants } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { PasswordInput } from '~/components/ui/password-input';
import { createExternalSource, ZOHO_CALENDAR_CONNECT_PATH } from '~/lib/api/integrations';
import { cn } from '~/lib/utils';
import { useAuth } from '~/providers/AuthProvider';
import { PROVIDERS, type ProviderKey } from './model';

export function AddIntegrationDrawer({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Integrations"
      title="Connect a source."
      description="Choose a provider and give it its credentials"
      className="w-[min(560px,100vw)]"
    >
      {open && <Form onDone={onAdded} />}
    </Drawer>
  );
}

function Form({ onDone }: { onDone: () => void }) {
  const { entity } = useAuth();
  const [provider, setProvider] = useState<ProviderKey>('shopify');
  const [account, setAccount] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const config = PROVIDERS[provider];
  const compound = config.credential === 'compound';
  const oauth = config.credential === 'oauth';
  const ready = oauth
    ? false
    : !!account.trim() && (compound ? !!clientId.trim() && !!secret.trim() : !!apiKey.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entity?.id) return setError('No business is set up for your account yet.');
    if (!ready) return setError('Fill in every field marked required.');
    setBusy(true);
    setError('');
    try {
      const credential = compound
        ? JSON.stringify(
            provider === 'shopify'
              ? { client_id: clientId.trim(), client_secret: secret.trim() }
              : { client_id: clientId.trim(), secret: secret.trim() }
          )
        : apiKey.trim();
      const result = await createExternalSource({
        entity_id: entity.id,
        provider,
        external_account_id: account.trim(),
        display_name: displayName.trim() || undefined,
        api_key: credential,
      });
      if (result) onDone();
      else setError('That could not be connected. Check the details and try again.');
    } catch {
      setError('That could not be connected. Check the details and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="eyebrow">Connecting for</div>
        <div className="mt-1 text-[15px]">{entity?.name || 'No business yet'}</div>
      </div>

      <fieldset className="space-y-2.5">
        <legend className="eyebrow mb-2.5">Provider</legend>
        <div role="radiogroup" aria-label="Provider" className="grid gap-2.5 sm:grid-cols-2">
          {(Object.keys(PROVIDERS) as ProviderKey[]).map(key => {
            const p = PROVIDERS[key];
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={provider === key}
                onClick={() => setProvider(key)}
                className={cn(
                  'rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  provider === key
                    ? 'border-ring bg-accent-tint'
                    : 'border-border-strong hover:border-ring'
                )}
              >
                <span className="flex items-center gap-2.5 text-text-2">
                  {p.icon}
                  <span className="font-serif text-[20px] text-foreground">{p.name}</span>
                </span>
                <span className="mt-2 block text-[13px] text-text-2">{p.description}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {oauth ? (
        <div className="space-y-3 rounded-xl border bg-background p-4">
          <p className="text-[14px] text-text-2">
            Zoho Calendar signs in through Zoho instead of a pasted key. You will be asked to log in
            and allow access, so use the account whose calendar you want synced.
          </p>
          {entity?.id && (
            <a href={ZOHO_CALENDAR_CONNECT_PATH} className={buttonVariants({})}>
              <CalendarBlank size={16} aria-hidden /> Connect with Zoho
            </a>
          )}
        </div>
      ) : (
        <>
          <Field label={`${config.accountLabel} (required)`}>
            <Input
              placeholder={config.accountPlaceholder}
              value={account}
              onChange={e => setAccount(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Display name (optional)">
            <Input
              placeholder="My store"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
          </Field>
          {compound ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client ID (required)">
                  <Input
                    value={clientId}
                    onChange={e => setClientId(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label={provider === 'shopify' ? 'Client secret (required)' : 'Secret (required)'}
                >
                  <PasswordInput
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <p className="text-[13px] text-text-2">{config.keyHelp}</p>
            </div>
          ) : (
            <Field label="API key (required)" hint={config.keyHelp}>
              <PasswordInput
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
        </>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[14px] text-destructive"
        >
          <Warning size={16} aria-hidden className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      {!oauth && (
        <Button type="submit" disabled={busy || !ready}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      )}
    </form>
  );
}
