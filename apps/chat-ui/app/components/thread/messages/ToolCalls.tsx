import React, { useState } from 'react';
import type { Message } from '@langchain/langgraph-sdk';
import { CaretDown, CaretUp, Wrench, CheckCircle, XCircle } from 'phosphor-react';
import { cn } from '~/lib/utils';

interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
  type?: string;
  status?: string;
  result?: any;
}

function isComplexValue(value: any): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}

export function ToolCalls({ toolCalls }: { toolCalls: ToolCall[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="space-y-2">
      {toolCalls.map((tc, idx) => {
        const args = tc.args as Record<string, any>;
        const hasArgs = Object.keys(args).length > 0;
        
        return (
          <div key={idx} className="overflow-hidden rounded-lg border-2 border-amber-500/30 bg-amber-500/5">
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Wrench size={16} weight="duotone" className="text-amber-600 dark:text-amber-400" />
                <h3 className="font-semibold text-amber-900 dark:text-amber-100">
                  {tc.name}
                </h3>
                {tc.id && (
                  <code className="ml-auto rounded bg-amber-500/20 px-2 py-0.5 text-xs font-mono text-amber-800 dark:text-amber-200">
                    {tc.id}
                  </code>
                )}
              </div>
            </div>
            {hasArgs ? (
              <div className="p-3">
                <div className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-2">Arguments:</div>
                <table className="min-w-full divide-y divide-amber-500/20">
                  <tbody className="divide-y divide-amber-500/20">
                    {Object.entries(args).map(([key, value], argIdx) => (
                      <tr key={argIdx} className="hover:bg-amber-500/5">
                        <td className="px-3 py-2 text-sm font-medium whitespace-nowrap text-amber-900 dark:text-amber-100">
                          {key}
                        </td>
                        <td className="px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                          {isComplexValue(value) ? (
                            <code className="rounded bg-amber-500/10 px-2 py-1 font-mono text-xs break-all block">
                              {JSON.stringify(value, null, 2)}
                            </code>
                          ) : (
                            String(value)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-3">
                <code className="text-xs text-amber-600 dark:text-amber-400">{'{}'}</code>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ToolResult({ message }: { message: Message }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Extract content string from LangGraph Message
  const getContentString = (): string => {
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part.type === 'text' && part.text) return part.text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return String(message.content);
  };

  const contentString = getContentString();
  let parsedContent: any;
  let isJsonContent = false;

  try {
    parsedContent = JSON.parse(contentString);
    isJsonContent = isComplexValue(parsedContent);
  } catch {
    parsedContent = contentString;
  }

  const contentStr = isJsonContent
    ? JSON.stringify(parsedContent, null, 2)
    : contentString;
  const contentLines = contentStr.split('\n');
  const shouldTruncate = contentLines.length > 4 || contentStr.length > 500;
  const displayedContent =
    shouldTruncate && !isExpanded
      ? contentStr.length > 500
        ? contentStr.slice(0, 500) + '...'
        : contentLines.slice(0, 4).join('\n') + '\n...'
      : contentStr;

  // Extract tool name from LangGraph message
  const toolName = 'name' in message && message.name ? message.name : 'Unknown Tool';

  return (
    <div className="max-w-3xl">
      <div className="overflow-hidden rounded-lg border-2 border-emerald-500/30 bg-emerald-500/5 shadow-sm">
        {/* Tool Header */}
        <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20">
              <CheckCircle size={18} weight="duotone" className="text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-emerald-900 dark:text-emerald-100">
                  Tool Execution Result
                </h3>
                <code className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-mono font-semibold text-emerald-800 dark:text-emerald-200">
                  {toolName}
                </code>
              </div>
              <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-0.5">
                Successfully completed
              </p>
            </div>
          </div>
        </div>

        {/* Tool Result Content */}
        <div className="bg-emerald-500/5">
          <div className="p-4">
            <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 mb-2">
              Response:
            </div>
            {isJsonContent ? (
              <div className="rounded-md bg-emerald-950/10 dark:bg-emerald-950/30 border border-emerald-500/20">
                <table className="min-w-full divide-y divide-emerald-500/20">
                  <tbody className="divide-y divide-emerald-500/20">
                    {(Array.isArray(parsedContent)
                      ? isExpanded
                        ? parsedContent
                        : parsedContent.slice(0, 5)
                      : Object.entries(parsedContent)
                    ).map((item, argIdx) => {
                      const [key, value] = Array.isArray(parsedContent)
                        ? [argIdx, item]
                        : [item[0], item[1]];
                      return (
                        <tr key={argIdx} className="hover:bg-emerald-500/5">
                          <td className="px-3 py-2 text-sm font-medium whitespace-nowrap text-emerald-900 dark:text-emerald-100 w-1/3">
                            {key}
                          </td>
                          <td className="px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                            {isComplexValue(value) ? (
                              <code className="rounded bg-emerald-500/10 px-2 py-1 font-mono text-xs break-all block whitespace-pre-wrap">
                                {JSON.stringify(value, null, 2)}
                              </code>
                            ) : (
                              <span className="break-words">{String(value)}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <code className="block text-sm text-emerald-700 dark:text-emerald-300 whitespace-pre-wrap font-mono bg-emerald-950/10 dark:bg-emerald-950/30 p-3 rounded-md border border-emerald-500/20">
                {displayedContent}
              </code>
            )}
          </div>

          {/* Expand/Collapse Button */}
          {((shouldTruncate && !isJsonContent) ||
            (isJsonContent && Array.isArray(parsedContent) && parsedContent.length > 5)) && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={cn(
                "flex w-full items-center justify-center gap-1 border-t border-emerald-500/30 py-2.5",
                "text-sm font-medium text-emerald-700 dark:text-emerald-300",
                "transition-colors hover:bg-emerald-500/10"
              )}
            >
              {isExpanded ? (
                <>
                  <CaretUp size={16} weight="bold" />
                  Show less
                </>
              ) : (
                <>
                  <CaretDown size={16} weight="bold" />
                  Show more ({isJsonContent && Array.isArray(parsedContent) 
                    ? `${parsedContent.length - 5} more items` 
                    : 'full content'})
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
