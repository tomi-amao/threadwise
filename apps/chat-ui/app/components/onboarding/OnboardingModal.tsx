/**
 * Onboarding Modal
 *
 * Five short questions after sign-up: industry, what the business does, website, where it is
 * based, and team size. Industry and team size are single taps; the description and website are
 * optional; the country is required (and starts as the United Kingdom, which is what the books
 * are kept for). Cannot be dismissed, but each optional step can be skipped.
 */

import { useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { useAuth } from '~/providers/AuthProvider';
import { cn } from '~/lib/utils';
import type { EmployeeCountRange, IndustryType, OnboardingData } from '~/types/auth';

interface OnboardingModalProps {
  open: boolean;
  onComplete: () => void;
}

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

const EMPLOYEE_COUNTS: { value: EmployeeCountRange; label: string }[] = [
  { value: '1-10', label: '1 to 10' },
  { value: '11-50', label: '11 to 50' },
  { value: '51-200', label: '51 to 200' },
  { value: '201-500', label: '201 to 500' },
  { value: '501-1000', label: '501 to 1,000' },
  { value: '1000+', label: 'Over 1,000' },
];

const STEPS = ['industry', 'about', 'website', 'country', 'team'] as const;

function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2.5">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-xl border px-4 py-3 text-left text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === o.value
              ? 'border-ring bg-accent-tint text-foreground'
              : 'border-border-strong bg-card text-text-2 hover:border-ring hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mt-3 font-serif text-[30px] font-light leading-tight tracking-[-0.02em]">
    {children}
  </h2>
);

export function OnboardingModal({ open, onComplete }: OnboardingModalProps) {
  const { entity, updateEntity } = useAuth();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OnboardingData>({
    industry: null,
    description: '',
    website: '',
    country: 'United Kingdom',
    employeeCount: null,
  });

  const id = STEPS[step];
  const last = step === STEPS.length - 1;
  const canContinue =
    id === 'industry'
      ? data.industry !== null
      : id === 'country'
        ? data.country.trim() !== ''
        : id === 'team'
          ? data.employeeCount !== null
          : true;
  const optional = id === 'about' || id === 'website';

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      const { error: failure } = await updateEntity({
        industry: data.industry,
        description: data.description || null,
        website: data.website || null,
        country: data.country || null,
        employee_count: data.employeeCount,
        onboarding_completed: true,
        updated_at: new Date().toISOString(),
      });
      if (failure) setError('That did not save. Try again.');
      else onComplete();
    } catch {
      setError('That did not save. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const next = () => (last ? submit() : setStep(s => s + 1));

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        hideCloseButton
        className="overflow-hidden rounded-2xl sm:max-w-[460px]"
        onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Set up your business</DialogTitle>
          <DialogDescription>A few questions about your business</DialogDescription>
        </DialogHeader>

        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={step + 1}
          className="flex gap-1.5"
        >
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={cn('h-1 flex-1 rounded-full', i <= step ? 'bg-ramp-1' : 'bg-border')}
            />
          ))}
        </div>

        <div key={id} className="rise min-h-[300px] pt-3">
          <div className="eyebrow">
            Step {step + 1} of {STEPS.length}
          </div>
          {id === 'industry' && (
            <>
              <Heading>What kind of business is it?</Heading>
              <p className="mb-5 mt-2 text-[15px] text-text-2">
                It helps us set up sensible defaults. You can change it later.
              </p>
              <Choices
                label="Industry"
                value={data.industry}
                options={INDUSTRIES}
                onChange={industry => setData(d => ({ ...d, industry }))}
              />
            </>
          )}
          {id === 'about' && (
            <>
              <Heading>What does {entity?.name || 'your business'} do?</Heading>
              <p className="mb-5 mt-2 text-[15px] text-text-2">A sentence or two. Optional.</p>
              <Field label="About the business">
                <Textarea
                  rows={4}
                  placeholder="We design and sell knitwear, made in small runs in Portugal."
                  value={data.description}
                  onChange={e => setData(d => ({ ...d, description: e.target.value }))}
                />
              </Field>
            </>
          )}
          {id === 'website' && (
            <>
              <Heading>Where do people find you?</Heading>
              <p className="mb-5 mt-2 text-[15px] text-text-2">Your website or shop. Optional.</p>
              <Field label="Website">
                <Input
                  type="url"
                  placeholder="https://yourbrand.com"
                  value={data.website}
                  onChange={e => setData(d => ({ ...d, website: e.target.value }))}
                />
              </Field>
            </>
          )}
          {id === 'country' && (
            <>
              <Heading>Where is it based?</Heading>
              <p className="mb-5 mt-2 text-[15px] text-text-2">
                Tax and VAT follow UK rules for now, and amounts are in pounds.
              </p>
              <Field label="Country">
                <Input
                  autoComplete="country-name"
                  value={data.country}
                  onChange={e => setData(d => ({ ...d, country: e.target.value }))}
                />
              </Field>
            </>
          )}
          {id === 'team' && (
            <>
              <Heading>How big is the team?</Heading>
              <p className="mb-5 mt-2 text-[15px] text-text-2">Including you.</p>
              <Choices
                label="Team size"
                value={data.employeeCount}
                options={EMPLOYEE_COUNTS}
                onChange={employeeCount => setData(d => ({ ...d, employeeCount }))}
              />
            </>
          )}
        </div>

        {error && (
          <p role="alert" className="text-[14px] text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between border-t pt-4">
          <Button
            variant="ghost"
            onClick={() => setStep(s => s - 1)}
            className={step === 0 ? 'invisible' : undefined}
            disabled={loading}
          >
            Back
          </Button>
          <div className="flex items-center gap-2">
            {optional && (
              <Button variant="ghost" onClick={next}>
                Skip
              </Button>
            )}
            <Button onClick={next} disabled={!canContinue || loading}>
              {last ? (loading ? 'Finishing…' : 'Finish setup') : 'Continue'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
