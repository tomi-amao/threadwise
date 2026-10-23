/**
 * Choices the user answers with a click: follow-up questions after an answer, and the
 * options of a clarifying question the agent paused on.
 */

import { Link } from 'react-router';
import { ArrowRight } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import type { ComponentProps, Clarify, Proposal } from './catalogue';

function ChoiceButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-left text-sm text-text-2 transition-colors',
        'hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60'
      )}
    >
      {children}
    </button>
  );
}

/** Questions to ask next. Clicking one sends its full prompt (the label can be shorter). */
export function FollowUpChips({
  data,
  onSelect,
  disabled,
}: {
  data: ComponentProps['follow-ups'];
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <nav aria-label="Suggested questions">
      <ul className="flex flex-wrap gap-2">
        {data.items.map(item => (
          <li key={item.prompt} className="max-w-full">
            <ChoiceButton
              onClick={() => onSelect(item.prompt)}
              disabled={disabled}
              title={item.prompt}
            >
              <span className="min-w-0 truncate">{item.label}</span>
              <ArrowRight size={12} aria-hidden className="shrink-0" />
            </ChoiceButton>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A question the agent paused on. The user clicks an option, or types an answer instead. */
export function ClarifyPrompt({
  clarify,
  onAnswer,
  disabled,
}: {
  clarify: Clarify;
  onAnswer: (answer: string) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={clarify.question} className="rounded-2xl border bg-card p-4">
      <p className="text-sm font-medium">{clarify.question}</p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {clarify.options.map(option => (
          <li key={option.label}>
            <ChoiceButton onClick={() => onAnswer(option.label)} disabled={disabled}>
              {option.label}
            </ChoiceButton>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">Or type your answer below.</p>
    </div>
  );
}

/**
 * A change the agent proposes. The run is paused: nothing has happened, and nothing will
 * unless the user approves. What is shown was built by the server from the record as the
 * user can see it, not from the model's words.
 */
export function ProposalCard({
  proposal,
  onDecide,
  disabled,
}: {
  proposal: Proposal;
  onDecide: (decision: 'approve' | 'dismiss') => void;
  disabled?: boolean;
}) {
  return (
    <section
      aria-label={`Proposed change: ${proposal.title}`}
      className="rounded-2xl border border-border-strong bg-card p-4"
    >
      <p className="eyebrow">Proposed change</p>
      <h3 className="mt-1 text-[15px] font-medium">{proposal.title}</h3>
      {proposal.description && <p className="mt-1 text-sm text-text-2">{proposal.description}</p>}
      <dl className="mt-3 space-y-2 text-sm">
        {proposal.changes.map(change => (
          <div key={change.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <dt className="w-20 shrink-0 text-xs text-muted-foreground">{change.label}</dt>
            <dd className="min-w-0 flex-1">
              {change.before != null && (
                <>
                  <span className="text-text-2 line-through decoration-muted-foreground/60">
                    {change.before}
                  </span>
                  <span aria-hidden className="mx-2 text-muted-foreground">
                    →
                  </span>
                  <span className="sr-only"> changes to </span>
                </>
              )}
              <span className="font-medium">{change.after}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Nothing changes until you approve it.
        {proposal.link && (
          <>
            {' '}
            <Link
              to={proposal.link}
              className="text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open the record
            </Link>
          </>
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onDecide('approve')} disabled={disabled}>
          {proposal.approve_label}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide('dismiss')} disabled={disabled}>
          {proposal.dismiss_label}
        </Button>
      </div>
    </section>
  );
}
