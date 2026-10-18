/**
 * One conversation: the messages, grouped into turns, and the composer.
 *
 * A turn is the user's message, then what the agent did (steps, with any text it wrote on the
 * way), its answer, the cards built from the tools' results, and its actions. Follow-up chips
 * show under the latest answer only; a clarifying question the agent paused on shows its
 * options. Used by the panel and by the full-width `/chat` page.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { Message } from '@langchain/langgraph-sdk';
import type { UIMessage } from '@langchain/langgraph-sdk/react-ui';
import {
  ArrowClockwise,
  ArrowUp,
  CheckCircle,
  CircleNotch,
  Copy,
  PencilSimple,
  Square,
  ThumbsDown,
  ThumbsUp,
  WarningCircle,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { useAssistant } from '~/providers/AssistantProvider';
import { AssistantCard } from './cards';
import { parseUiMessage, type ParsedUi } from './catalogue';
import { ClarifyPrompt, FollowUpChips } from './chips';
import { Markdown } from './Markdown';
import { messageText, startersFor, stepLabel, toolCalls } from './text';

interface Turn {
  human: Message | null;
  agent: Message[];
}

function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.type === 'human') turns.push({ human: message, agent: [] });
    else if (turns.length === 0) turns.push({ human: null, agent: [message] });
    else turns[turns.length - 1].agent.push(message);
  }
  return turns;
}

/** Validated UI messages, grouped by the message they belong to. */
function useUiByMessage(ui: UIMessage[]) {
  return useMemo(() => {
    const byMessage = new Map<string, ParsedUi[]>();
    for (const raw of ui) {
      const id = (raw.metadata as { message_id?: string } | undefined)?.message_id;
      if (!id) continue;
      const parsed = parseUiMessage(raw as Parameters<typeof parseUiMessage>[0]);
      if (!parsed) continue;
      byMessage.set(id, [...(byMessage.get(id) ?? []), parsed]);
    }
    return byMessage;
  }, [ui]);
}

export function Conversation() {
  const assistant = useAssistant();
  const { messages, isLoading, isThreadLoading, error, clarify } = assistant;
  const turns = useMemo(() => toTurns(messages), [messages]);
  const uiByMessage = useUiByMessage(assistant.ui);
  const scroller = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  // Follow the answer as it streams, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, assistant.ui, isLoading, clarify]);

  const empty = turns.length === 0 && !isThreadLoading;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={e => {
          const el = e.currentTarget;
          stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4"
      >
        {empty ? (
          <EmptyThread />
        ) : (
          <div
            role="log"
            aria-label="Conversation"
            aria-busy={isLoading}
            className="space-y-8 py-4"
          >
            {isThreadLoading && turns.length === 0 && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleNotch size={14} className="animate-spin" aria-hidden />
                Loading the conversation…
              </p>
            )}
            {turns.map((turn, i) => (
              <TurnView
                key={turn.human?.id ?? `turn-${i}`}
                turn={turn}
                latest={i === turns.length - 1}
                uiByMessage={uiByMessage}
              />
            ))}
          </div>
        )}
        {/* Outside the log, so a first question that fails still says so. */}
        {error != null && !isLoading && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/40 bg-card px-4 py-3 text-sm"
          >
            <WarningCircle size={18} className="shrink-0 text-destructive" aria-hidden />
            <span className="min-w-0 flex-1">
              {assistant.canRetry
                ? 'The assistant could not answer. Try again.'
                : 'The assistant is not available right now.'}
            </span>
            {assistant.canRetry && (
              <Button size="sm" variant="outline" onClick={assistant.retry}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
      <Composer />
    </div>
  );
}

function EmptyThread() {
  const { send } = useAssistant();
  const { pathname } = useLocation();
  return (
    <div className="py-8">
      <h3 className="font-serif text-2xl">Ask about your business.</h3>
      <p className="mt-2 text-sm text-text-2">
        Answers come from your own records, with the figures shown and a link to where they live.
        The assistant can read, not change, anything.
      </p>
      <p className="eyebrow mt-6">Try</p>
      <ul className="mt-2 space-y-2">
        {startersFor(pathname).map(prompt => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => send(prompt)}
              className="w-full rounded-xl border bg-card px-3.5 py-2.5 text-left text-sm text-text-2 transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TurnView({
  turn,
  latest,
  uiByMessage,
}: {
  turn: Turn;
  latest: boolean;
  uiByMessage: Map<string, ParsedUi[]>;
}) {
  const assistant = useAssistant();
  const busy = latest && assistant.isLoading;
  const results = new Map(
    turn.agent
      .filter(m => m.type === 'tool')
      .map(m => [(m as { tool_call_id?: string }).tool_call_id, m] as const)
  );
  const finalAnswer = [...turn.agent]
    .reverse()
    .find(m => m.type === 'ai' && messageText(m).trim() && toolCalls(m).length === 0);
  const ids = turn.agent.map(m => m.id).filter((id): id is string => !!id);
  const parts = ids.flatMap(id => uiByMessage.get(id) ?? []);
  const cards = parts.filter(p => p.name !== 'follow-ups');
  const followUps = parts.filter(p => p.name === 'follow-ups').at(-1);

  return (
    <article aria-label={turn.human ? `You asked: ${messageText(turn.human)}` : 'Assistant'}>
      {turn.human && <HumanMessage message={turn.human} />}
      <div className="mt-4 space-y-3">
        {turn.agent.map(message => {
          if (message.type !== 'ai') return null;
          const calls = toolCalls(message);
          const text = messageText(message).trim();
          return (
            <div key={message.id} className="space-y-2">
              {text && message !== finalAnswer && (
                <div className="text-sm text-text-2">
                  <Markdown>{text}</Markdown>
                </div>
              )}
              {calls.length > 0 && (
                <ul aria-label="Steps" className="space-y-1">
                  {calls.map(call => {
                    const result = call.id ? results.get(call.id) : undefined;
                    const failed = (result as { status?: string } | undefined)?.status === 'error';
                    return (
                      <li
                        key={call.id ?? call.name}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        {result ? (
                          failed ? (
                            <WarningCircle size={14} className="text-destructive" aria-hidden />
                          ) : (
                            <CheckCircle size={14} aria-hidden />
                          )
                        ) : busy ? (
                          <CircleNotch size={14} className="animate-spin" aria-hidden />
                        ) : (
                          <CheckCircle size={14} aria-hidden />
                        )}
                        <span className="min-w-0">
                          {stepLabel(call)}
                          {failed && ' (failed)'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}

        {busy && !finalAnswer && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleNotch size={14} className="animate-spin" aria-hidden />
            {assistant.progress ? `${assistant.progress}…` : 'Thinking…'}
          </p>
        )}

        {finalAnswer && <Markdown>{messageText(finalAnswer)}</Markdown>}

        {cards.length > 0 && (
          <div className="space-y-3">
            {cards.map(ui => (
              <AssistantCard key={ui.id} ui={ui} />
            ))}
          </div>
        )}

        {finalAnswer && !busy && <AnswerActions message={finalAnswer} latest={latest} />}

        {latest && !assistant.isLoading && assistant.clarify && (
          <ClarifyPrompt clarify={assistant.clarify} onAnswer={assistant.answer} />
        )}

        {latest &&
          !assistant.isLoading &&
          !assistant.clarify &&
          followUps?.name === 'follow-ups' && (
            <FollowUpChips data={followUps.props} onSelect={assistant.send} />
          )}
      </div>
    </article>
  );
}

function HumanMessage({ message }: { message: Message }) {
  const assistant = useAssistant();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(messageText(message));
  const text = messageText(message);

  if (editing) {
    return (
      <form
        className="ml-auto max-w-[90%] space-y-2"
        onSubmit={e => {
          e.preventDefault();
          setEditing(false);
          assistant.edit(message, draft);
        }}
      >
        <label className="sr-only" htmlFor={`edit-${message.id}`}>
          Edit your question
        </label>
        <textarea
          id={`edit-${message.id}`}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-xl border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            Send again
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="group flex items-start justify-end gap-1">
      {assistant.canEdit(message) && (
        <button
          type="button"
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
          className="mt-1.5 rounded-md p-1 text-muted-foreground opacity-100 transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          aria-label="Edit question"
        >
          <PencilSimple size={14} aria-hidden />
        </button>
      )}
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border bg-card px-3.5 py-2.5 text-[15px]">
        {text}
      </p>
    </div>
  );
}

function AnswerActions({ message, latest }: { message: Message; latest: boolean }) {
  const assistant = useAssistant();
  const [copied, setCopied] = useState(false);
  const id = message.id ?? '';
  const given = assistant.feedback[id];
  const iconButton =
    'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-accent-text';
  return (
    <div className="-ml-1.5 flex items-center gap-0.5">
      <button
        type="button"
        className={iconButton}
        aria-label={copied ? 'Copied' : 'Copy answer'}
        onClick={() => {
          void navigator.clipboard?.writeText(messageText(message)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <CheckCircle size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </button>
      {id && (
        <>
          <button
            type="button"
            className={iconButton}
            aria-label="Good answer"
            aria-pressed={given === 'up'}
            onClick={() => assistant.setFeedback(id, given === 'up' ? null : 'up')}
          >
            <ThumbsUp size={16} weight={given === 'up' ? 'fill' : 'regular'} aria-hidden />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label="Bad answer"
            aria-pressed={given === 'down'}
            onClick={() => assistant.setFeedback(id, given === 'down' ? null : 'down')}
          >
            <ThumbsDown size={16} weight={given === 'down' ? 'fill' : 'regular'} aria-hidden />
          </button>
        </>
      )}
      {latest && assistant.canRegenerate(message) && (
        <button
          type="button"
          className={iconButton}
          aria-label="Answer again"
          onClick={() => assistant.regenerate(message)}
        >
          <ArrowClockwise size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

function Composer() {
  const assistant = useAssistant();
  const [draft, setDraft] = useState('');
  const answering = !!assistant.clarify && !assistant.isLoading;

  const submit = () => {
    const text = draft.trim();
    if (!text || assistant.isLoading) return;
    if (answering) assistant.answer(text);
    else assistant.send(text);
    setDraft('');
  };

  // Grow with the text, up to about eight lines.
  useEffect(() => {
    const el = assistant.composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft, assistant.composerRef]);

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        submit();
      }}
      className="shrink-0 border-t bg-background p-3"
    >
      <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 focus-within:border-border-strong">
        <label htmlFor="assistant-composer" className="sr-only">
          {answering ? 'Your answer' : 'Ask about your business'}
        </label>
        <textarea
          id="assistant-composer"
          ref={assistant.composerRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={answering ? 'Type your answer…' : 'Ask about your business…'}
          className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] placeholder:text-muted-foreground focus-visible:outline-none"
        />
        {assistant.isLoading ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={assistant.stop}
            aria-label="Stop"
            className="size-9 shrink-0 rounded-xl"
          >
            <Square size={14} weight="fill" aria-hidden />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!draft.trim()}
            aria-label={answering ? 'Send answer' : 'Send'}
            className="size-9 shrink-0 rounded-xl"
          >
            <ArrowUp size={16} weight="bold" aria-hidden />
          </Button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
        Reads your records only. Check figures that matter on their page.
      </p>
    </form>
  );
}
