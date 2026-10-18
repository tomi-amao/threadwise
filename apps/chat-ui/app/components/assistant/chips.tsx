/**
 * Choices the user answers with a click: follow-up questions after an answer, and the
 * options of a clarifying question the agent paused on.
 */

import { ArrowRight } from 'phosphor-react';
import { cn } from '~/lib/utils';
import type { ComponentProps, Clarify } from './catalogue';

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
