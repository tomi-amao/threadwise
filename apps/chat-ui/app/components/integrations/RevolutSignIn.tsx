/**
 * Revolut Business sign-in: the one-time setup in Revolut and the "Connect with Revolut" form.
 *
 * Revolut's Business API has no shared app: each business uploads ThreadWise's public
 * certificate in its own Revolut account, which gives it a client ID. After that the sign-in is
 * a consent page on Revolut, and the access it grants renews itself, so no token is ever pasted.
 * The form is a plain GET to the app's connect route (it redirects to Revolut); the agent keeps
 * the refresh token in the Vault. See apps/ai_agent/src/ai_agent/integrations/revolut/oauth.py.
 */

import { useEffect, useState } from 'react';
import { Bank, CheckCircle, Copy, DownloadSimple, ShieldCheck } from 'phosphor-react';
import { Button, buttonVariants } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import {
  getRevolutSetup,
  REVOLUT_CERTIFICATE_PATH,
  REVOLUT_CONNECT_PATH,
  type IntegrationSummary,
  type RevolutSetup,
} from '~/lib/api/integrations';

/** Whether this server offers the Revolut sign-in (null while asking, or if the agent is down). */
export function useRevolutSetup(): RevolutSetup | null {
  const [setup, setSetup] = useState<RevolutSetup | null>(null);
  useEffect(() => {
    let live = true;
    void getRevolutSetup().then(result => live && setSetup(result));
    return () => {
      live = false;
    };
  }, []);
  return setup;
}

/** Link that starts the sign-in again for an integration already signed in (same client ID). */
export const revolutReconnectHref = (sourceId: string) =>
  `${REVOLUT_CONNECT_PATH}?${new URLSearchParams({ source_id: sourceId })}`;

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="shrink-0 rounded-md p-1 text-text-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={copied ? 'Copied' : `Copy the ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <CheckCircle size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>
    </div>
  );
}

/** The one-time steps in Revolut Business, ending with the client ID field and Connect. */
export function RevolutSetupSteps({
  redirectUri,
  clientId,
  onClientId,
}: {
  redirectUri: string;
  clientId: string;
  onClientId: (value: string) => void;
}) {
  return (
    <ol className="space-y-4 text-[14px]">
      <li className="space-y-2">
        <p>
          <span className="font-medium">1. Download the ThreadWise certificate.</span>{' '}
          <span className="text-text-2">
            It holds only a public key. The private key never leaves ThreadWise.
          </span>
        </p>
        <a
          href={REVOLUT_CERTIFICATE_PATH}
          download="threadwise-revolut.cer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <DownloadSimple size={14} aria-hidden /> Download certificate
        </a>
      </li>
      <li className="space-y-2">
        <p>
          <span className="font-medium">2. Add it in Revolut Business.</span>{' '}
          <span className="text-text-2">
            Settings, APIs, Business API, Add API certificate. Upload the file and paste this as the
            OAuth redirect URI:
          </span>
        </p>
        <CopyValue value={redirectUri} label="redirect URI" />
      </li>
      <li className="space-y-2">
        <p>
          <span className="font-medium">3. Paste the client ID Revolut shows for it.</span>
        </p>
        <Field label="Client ID (required)">
          <Input
            name="client_id"
            value={clientId}
            onChange={e => onClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </li>
    </ol>
  );
}

const SCOPE_NOTE =
  'ThreadWise asks Revolut for read-only access: accounts, transactions and receipts. It can never make payments.';

/**
 * On a Revolut integration's card: signed in (renews itself), or a pasted token with the setup to
 * switch it to the sign-in in place, keeping everything already synced.
 */
export function RevolutSignInSection({ integration }: { integration: IntegrationSummary }) {
  const setup = useRevolutSetup();
  const signedIn = integration.auth_method === 'oauth';
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');

  // Still asking the agent (or it is down): show nothing rather than a wrong answer.
  if (!setup && !signedIn) return null;

  return (
    <section aria-label="Revolut sign-in" className="space-y-3 rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <ShieldCheck
            size={18}
            weight="light"
            aria-hidden
            className="mt-0.5 shrink-0 text-text-2"
          />
          <div>
            <h3 className="text-[15px] font-medium">Sign-in</h3>
            <p className="mt-0.5 text-[14px] text-text-2">
              {signedIn
                ? 'Signed in with Revolut. Access renews itself, so there is nothing to paste.'
                : 'This integration uses a pasted token, which Revolut expires after about 40 minutes. Connect with Revolut once and it renews itself. Everything already synced stays.'}
            </p>
          </div>
        </div>
        <Chip tone={signedIn ? 'done' : 'draft'}>
          {signedIn ? 'Signed in with Revolut' : 'Pasted token'}
        </Chip>
      </div>

      {signedIn ? (
        <a
          href={revolutReconnectHref(integration.id)}
          className="text-[14px] text-accent-text underline underline-offset-4 hover:text-foreground"
        >
          Reconnect with Revolut
        </a>
      ) : open && setup?.redirect_uri ? (
        <form method="get" action={REVOLUT_CONNECT_PATH} className="space-y-4">
          <input type="hidden" name="source_id" value={integration.id} />
          <RevolutSetupSteps
            redirectUri={setup.redirect_uri}
            clientId={clientId}
            onClientId={setClientId}
          />
          <p className="text-[13px] text-text-2">{SCOPE_NOTE}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!clientId.trim()}>
              <Bank size={14} aria-hidden /> Connect with Revolut
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : setup?.configured ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Set up Revolut sign-in
        </Button>
      ) : (
        <p className="text-[13px] text-text-2">
          Revolut sign-in is not set up on this server yet: it needs REVOLUT_PRIVATE_KEY in the AI
          agent&apos;s settings. Until then, paste a token with Update API key.
        </p>
      )}
    </section>
  );
}

/** The new-integration form for Revolut in the Add drawer: account, name, setup, Connect. */
export function RevolutConnectForm({ redirectUri }: { redirectUri: string }) {
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const ready = !!account.trim() && !!clientId.trim();

  return (
    <form method="get" action={REVOLUT_CONNECT_PATH} className="space-y-6">
      <Field label="Business ID (required)">
        <Input
          name="account"
          placeholder="Your Revolut business ID"
          value={account}
          onChange={e => setAccount(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label="Display name (optional)">
        <Input
          name="name"
          placeholder="My business"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </Field>
      <div className="space-y-4 rounded-xl border bg-background p-4">
        <p className="text-[14px] text-text-2">
          Revolut signs in through Revolut instead of a pasted token. Set it up once:
        </p>
        <RevolutSetupSteps redirectUri={redirectUri} clientId={clientId} onClientId={setClientId} />
        <p className="text-[13px] text-text-2">{SCOPE_NOTE}</p>
        <p className="text-[13px] text-text-2">
          Add the Merchant key, for the invoices you send from Revolut, on the integration once it
          is connected.
        </p>
      </div>
      <Button type="submit" disabled={!ready}>
        <Bank size={16} aria-hidden /> Connect with Revolut
      </Button>
    </form>
  );
}
