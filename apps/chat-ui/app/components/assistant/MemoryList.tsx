/**
 * What the assistant was asked to remember. Every item is visible and can be deleted here;
 * nothing is saved without the user approving it in the conversation first.
 */

import { useEffect, useState } from 'react';
import { Trash } from 'phosphor-react';
import { useAssistant } from '~/providers/AssistantProvider';

export function MemoryList() {
  const { memories, memoriesError, refreshMemories, deleteMemory } = useAssistant();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void refreshMemories();
  }, [refreshMemories]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="text-sm text-text-2">
        Things you asked the assistant to remember. It uses them to word its answers. It only saves
        one after you approve it, and you can delete any of them here.
      </p>
      {(memoriesError || failed) && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {failed ? 'That could not be deleted.' : 'Your memories could not be loaded.'}{' '}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => {
              setFailed(false);
              void refreshMemories();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {!memoriesError && memories.length === 0 && (
        <p className="py-6 text-sm text-text-2">
          Nothing yet. Try saying “My financial year starts in April, remember that.”
        </p>
      )}
      <ul aria-label="Remembered" className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {memories.map(memory => (
          <li
            key={memory.id}
            className="flex items-start gap-2 rounded-xl border bg-card px-3 py-2.5"
          >
            <span className="min-w-0 flex-1 break-words text-sm">{memory.fact}</span>
            <button
              type="button"
              aria-label={`Forget: ${memory.fact}`}
              onClick={async () => {
                try {
                  await deleteMemory(memory.id);
                } catch {
                  setFailed(true);
                }
              }}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
