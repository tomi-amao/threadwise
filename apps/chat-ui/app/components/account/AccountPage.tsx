/**
 * AccountPage: who you are, what the business is, how the app looks, and how you sign in. Each
 * section saves on its own, so changing the business never touches the profile.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import { CompactHeader } from '~/components/ui/page-header';
import { Panel } from '~/components/ui/panel';
import { PasswordInput } from '~/components/ui/password-input';
import { Textarea } from '~/components/ui/textarea';
import { ThemeToggle } from '~/components/ui/theme-toggle';
import { useAuth } from '~/providers/AuthProvider';
import type { EmployeeCountRange, IndustryType } from '~/types/auth';

const INDUSTRIES: { value: IndustryType; label: string }[] = [
  { value: 'retail', label: 'Retail and e-commerce' },
  { value: 'manufacturing', label: 'Making things' },
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'consulting', label: 'Consulting' },
  { value: 'technology', label: 'Technology' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'finance', label: 'Finance' },
  { value: 'education', label: 'Education' },
  { value: 'real_estate', label: 'Real estate' },
  { value: 'other', label: 'Something else' },
];

const TEAM_SIZES: { value: EmployeeCountRange; label: string }[] = [
  { value: '1-10', label: '1 to 10' },
  { value: '11-50', label: '11 to 50' },
  { value: '51-200', label: '51 to 200' },
  { value: '201-500', label: '201 to 500' },
  { value: '501-1000', label: '501 to 1,000' },
  { value: '1000+', label: 'Over 1,000' },
];

/** Run a save, toast the result, and hand back the error text for the section to show. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<{ error: Error | null } | void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result && result.error) setError(result.error.message);
      else toast.success(done);
    } catch {
      setError('That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const Alert = ({ text }: { text: string | null }) =>
  text ? (
    <p
      role="alert"
      className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[14px] text-destructive"
    >
      {text}
    </p>
  ) : null;

function ProfileSection() {
  const { user, profile, updateProfile } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? '');
  const save = useSave();
  return (
    <Panel title="You" note="How you appear in ThreadWise.">
      <form
        className="space-y-5"
        onSubmit={e => {
          e.preventDefault();
          if (name !== (profile?.full_name ?? '')) {
            save.run(() => updateProfile({ full_name: name.trim() }), 'Profile saved');
          }
        }}
      >
        <Field label="Your name">
          <Input value={name} autoComplete="name" onChange={e => setName(e.target.value)} />
        </Field>
        <dl className="grid gap-5 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <dt className="eyebrow">Email</dt>
            <dd className="mt-1.5 break-all text-[15px]">{user?.email}</dd>
          </div>
          <div>
            <dt className="eyebrow">Role</dt>
            <dd className="mt-1.5 text-[15px] capitalize">{profile?.role || 'Owner'}</dd>
          </div>
          <div>
            <dt className="eyebrow">Member since</dt>
            <dd className="mt-1.5 text-[15px]">
              {profile?.created_at
                ? new Date(profile.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })
                : '–'}
            </dd>
          </div>
        </dl>
        <Alert text={save.error} />
        <Button type="submit" disabled={save.busy || name === (profile?.full_name ?? '')}>
          {save.busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Panel>
  );
}

function BusinessSection() {
  const { entity, updateEntity } = useAuth();
  const [form, setForm] = useState({
    name: entity?.name ?? '',
    industry: (entity?.industry as IndustryType | null) ?? '',
    employeeCount: (entity?.employee_count as EmployeeCountRange | null) ?? '',
    website: entity?.website ?? '',
    description: entity?.description ?? '',
  });
  const save = useSave();
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
  const dirty =
    form.name !== (entity?.name ?? '') ||
    form.industry !== (entity?.industry ?? '') ||
    form.employeeCount !== (entity?.employee_count ?? '') ||
    form.website !== (entity?.website ?? '') ||
    form.description !== (entity?.description ?? '');

  return (
    <Panel
      title="Your business"
      note="The company your books are kept for. Tax details (company number, UTR, VAT) live on the Tax page."
    >
      <form
        className="space-y-5"
        onSubmit={e => {
          e.preventDefault();
          if (!form.name.trim()) return;
          save.run(
            () =>
              updateEntity({
                name: form.name.trim(),
                industry: form.industry || null,
                employee_count: form.employeeCount || null,
                website: form.website.trim() || null,
                description: form.description.trim() || null,
              }),
            'Business saved'
          );
        }}
      >
        <Field label="Business name">
          <Input
            value={form.name}
            autoComplete="organization"
            onChange={e => set({ name: e.target.value })}
            required
          />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Industry">
            <NativeSelect
              shape="field"
              aria-label="Industry"
              className="w-full"
              value={form.industry}
              onChange={e => set({ industry: e.target.value as IndustryType })}
            >
              <option value="">Not set</option>
              {INDUSTRIES.map(i => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Team size">
            <NativeSelect
              shape="field"
              aria-label="Team size"
              className="w-full"
              value={form.employeeCount}
              onChange={e => set({ employeeCount: e.target.value as EmployeeCountRange })}
            >
              <option value="">Not set</option>
              {TEAM_SIZES.map(i => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field label="Website">
          <Input
            type="url"
            placeholder="https://yourbrand.com"
            value={form.website}
            onChange={e => set({ website: e.target.value })}
          />
        </Field>
        <Field label="About">
          <Textarea
            rows={3}
            value={form.description}
            onChange={e => set({ description: e.target.value })}
          />
        </Field>
        <Alert text={save.error} />
        <Button type="submit" disabled={save.busy || !dirty || !form.name.trim()}>
          {save.busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Panel>
  );
}

function PasswordSection() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSave();

  return (
    <Panel title="Password" note="Choose a new one. You stay signed in on this device.">
      <form
        className="space-y-5"
        onSubmit={async e => {
          e.preventDefault();
          setProblem(null);
          if (password.length < 6) return setProblem('A password needs at least 6 characters.');
          if (password !== confirm) return setProblem('The two passwords do not match.');
          await save.run(() => updatePassword(password), 'Password changed');
          setPassword('');
          setConfirm('');
        }}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="New password">
            <PasswordInput
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
          </Field>
        </div>
        <Alert text={problem ?? save.error} />
        <Button type="submit" disabled={save.busy || !password}>
          {save.busy ? 'Changing…' : 'Change password'}
        </Button>
      </form>
    </Panel>
  );
}

export function AccountPage() {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Account"
        title={
          <>
            You, <em>and your business.</em>
          </>
        }
        description="Each section saves on its own."
      />
      <div className="mx-auto max-w-[860px] space-y-4 px-4 sm:px-6 lg:px-8">
        <ProfileSection />
        <BusinessSection />
        <Panel title="Appearance" note="Light or dark. Remembered on this device.">
          <ThemeToggle />
        </Panel>
        <PasswordSection />
        <Panel title="Sign out" note="End this session on this device.">
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              navigate('/login');
            }}
          >
            Sign out
          </Button>
        </Panel>
      </div>
    </div>
  );
}
