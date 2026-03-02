import React, { useState } from 'react';
import type { Message } from '@langchain/langgraph-sdk';
import {
  CaretDown,
  CaretUp,
  Wrench,
  CheckCircle,
  XCircle,
  CloudArrowUp,
  Database,
} from 'phosphor-react';
import { cn } from '~/lib/utils';
import {
  BarChartViz,
  LineChartViz,
  PieChartViz,
  FinancialTableViz,
  MetricCardViz,
} from '~/components/visualizations';

interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
  type?: string;
  status?: string;
  result?: any;
}

interface ChartData {
  __chart__: true;
  type: 'bar' | 'line' | 'pie' | 'table' | 'metric';
  title: string;
  format: 'currency' | 'number' | 'percentage';
  data?: any[];
  headers?: string[];
  rows?: any[];
  value?: number;
  trend?: {
    direction: 'up' | 'down' | 'neutral';
    value: number;
    period: string;
  };
  description?: string;
  error?: string;
}

function isComplexValue(value: any): boolean {
  return Array.isArray(value) || (typeof value === 'object' && value !== null);
}

/**
 * MCP tool detection - identifies tools from MCP servers
 * Supabase MCP tools have distinctive names like execute_sql, list_tables, etc.
 */
const MCP_TOOL_NAMES = new Set([
  'execute_sql',
  'list_tables',
  'list_extensions',
  'list_migrations',
  'apply_migration',
  'search_docs',
  'get_logs',
  'get_advisors',
  'get_project_url',
  'get_publishable_keys',
  'generate_typescript_types',
  'list_edge_functions',
  'get_edge_function',
  'deploy_edge_function',
  'create_branch',
  'list_branches',
  'delete_branch',
  'merge_branch',
  'reset_branch',
  'rebase_branch',
  'list_storage_buckets',
  'get_storage_config',
  'update_storage_config',
  'list_projects',
  'get_project',
  'create_project',
]);

export function isMCPTool(toolName: string): boolean {
  return MCP_TOOL_NAMES.has(toolName);
}

function getMCPToolLabel(toolName: string): string {
  // Format: "execute_sql" → "Execute SQL" etc.
  return toolName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function ToolCalls({ toolCalls }: { toolCalls: ToolCall[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="space-y-2">
      {toolCalls.map((tc, idx) => {
        const args = tc.args as Record<string, any>;
        const hasArgs = Object.keys(args).length > 0;
        const isMCP = isMCPTool(tc.name);

        // MCP tools use a teal/cyan color scheme to distinguish from SQL toolkit (amber)
        const colorScheme = isMCP
          ? {
              border: 'border-teal-500/30',
              bg: 'bg-teal-500/5',
              headerBg: 'bg-teal-500/10',
              headerBorder: 'border-teal-500/30',
              iconColor: 'text-teal-600 dark:text-teal-400',
              titleColor: 'text-teal-900 dark:text-teal-100',
              labelColor: 'text-teal-800 dark:text-teal-300',
              codeColor: 'text-teal-800 dark:text-teal-200',
              codeBg: 'bg-teal-500/20',
              argBg: 'bg-teal-500/10',
              divider: 'divide-teal-500/20',
              textColor: 'text-teal-700 dark:text-teal-300',
              hoverBg: 'hover:bg-teal-500/5',
              badgeBg: 'bg-teal-500/15',
              badgeText: 'text-teal-700 dark:text-teal-300',
            }
          : {
              border: 'border-amber-500/30',
              bg: 'bg-amber-500/5',
              headerBg: 'bg-amber-500/10',
              headerBorder: 'border-amber-500/30',
              iconColor: 'text-amber-600 dark:text-amber-400',
              titleColor: 'text-amber-900 dark:text-amber-100',
              labelColor: 'text-amber-800 dark:text-amber-300',
              codeColor: 'text-amber-800 dark:text-amber-200',
              codeBg: 'bg-amber-500/20',
              argBg: 'bg-amber-500/10',
              divider: 'divide-amber-500/20',
              textColor: 'text-amber-700 dark:text-amber-300',
              hoverBg: 'hover:bg-amber-500/5',
              badgeBg: '',
              badgeText: '',
            };

        return (
          <div
            key={idx}
            className={cn(
              'overflow-hidden rounded-lg border-2',
              colorScheme.border,
              colorScheme.bg
            )}
          >
            <div
              className={cn('border-b px-4 py-2.5', colorScheme.headerBorder, colorScheme.headerBg)}
            >
              <div className="flex items-center gap-2">
                {isMCP ? (
                  <CloudArrowUp size={16} weight="duotone" className={colorScheme.iconColor} />
                ) : (
                  <Wrench size={16} weight="duotone" className={colorScheme.iconColor} />
                )}
                <h3 className={cn('font-semibold', colorScheme.titleColor)}>
                  {isMCP ? getMCPToolLabel(tc.name) : tc.name}
                </h3>
                {isMCP && (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      colorScheme.badgeBg,
                      colorScheme.badgeText
                    )}
                  >
                    MCP
                  </span>
                )}
                {tc.id && (
                  <code
                    className={cn(
                      'ml-auto rounded px-2 py-0.5 text-xs font-mono',
                      colorScheme.codeBg,
                      colorScheme.codeColor
                    )}
                  >
                    {tc.id}
                  </code>
                )}
              </div>
            </div>
            {hasArgs ? (
              <div className="p-3">
                <div className={cn('text-xs font-semibold mb-2', colorScheme.labelColor)}>
                  Arguments:
                </div>
                <table className={cn('min-w-full divide-y', colorScheme.divider)}>
                  <tbody className={cn('divide-y', colorScheme.divider)}>
                    {Object.entries(args).map(([key, value], argIdx) => (
                      <tr key={argIdx} className={colorScheme.hoverBg}>
                        <td
                          className={cn(
                            'px-3 py-2 text-sm font-medium whitespace-nowrap',
                            colorScheme.titleColor
                          )}
                        >
                          {key}
                        </td>
                        <td className={cn('px-3 py-2 text-sm', colorScheme.textColor)}>
                          {isComplexValue(value) ? (
                            <code
                              className={cn(
                                'rounded px-2 py-1 font-mono text-xs break-all block',
                                colorScheme.argBg
                              )}
                            >
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
                <code className={cn('text-xs', colorScheme.textColor)}>{'{}'}</code>
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

  // Try to parse as chart data
  let chartData: ChartData | null = null;
  let parsedContent: any;
  let isJsonContent = false;

  try {
    parsedContent = JSON.parse(contentString);
    isJsonContent = isComplexValue(parsedContent);

    // Check if this is chart data from generate_graph or generate_metric_card
    if (parsedContent && parsedContent.__chart__ === true) {
      chartData = parsedContent as ChartData;
    }
  } catch {
    parsedContent = contentString;
  }

  // Extract tool name from LangGraph message
  const toolName = 'name' in message && message.name ? message.name : 'Unknown Tool';
  const isMCP = isMCPTool(toolName);

  // If we have chart data, render the appropriate visualization
  if (chartData && !chartData.error) {
    return (
      <div className="w-full">
        {chartData.type === 'bar' && chartData.data && (
          <BarChartViz title={chartData.title} data={chartData.data} format={chartData.format} />
        )}
        {chartData.type === 'line' && chartData.data && (
          <LineChartViz title={chartData.title} data={chartData.data} format={chartData.format} />
        )}
        {chartData.type === 'pie' && chartData.data && (
          <PieChartViz title={chartData.title} data={chartData.data} format={chartData.format} />
        )}
        {chartData.type === 'table' && chartData.rows && chartData.headers && (
          <FinancialTableViz
            title={chartData.title}
            data={{
              headers: chartData.headers,
              rows: chartData.rows,
            }}
            format={chartData.format}
          />
        )}
        {chartData.type === 'metric' && chartData.value !== undefined && (
          <MetricCardViz
            title={chartData.title}
            value={chartData.value}
            format={chartData.format}
            trend={chartData.trend}
            description={chartData.description}
          />
        )}
      </div>
    );
  }

  const contentStr = isJsonContent ? JSON.stringify(parsedContent, null, 2) : contentString;
  const contentLines = contentStr.split('\n');
  const shouldTruncate = contentLines.length > 4 || contentStr.length > 500;
  const displayedContent =
    shouldTruncate && !isExpanded
      ? contentStr.length > 500
        ? contentStr.slice(0, 500) + '...'
        : contentLines.slice(0, 4).join('\n') + '\n...'
      : contentStr;

  return (
    <div className="max-w-3xl">
      <div
        className={cn(
          'overflow-hidden rounded-lg border-2 shadow-sm',
          isMCP ? 'border-teal-500/30 bg-teal-500/5' : 'border-emerald-500/30 bg-emerald-500/5'
        )}
      >
        {/* Tool Header */}
        <div
          className={cn(
            'border-b px-4 py-3',
            isMCP ? 'border-teal-500/30 bg-teal-500/10' : 'border-emerald-500/30 bg-emerald-500/10'
          )}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full',
                isMCP ? 'bg-teal-500/20' : 'bg-emerald-500/20'
              )}
            >
              {isMCP ? (
                <CloudArrowUp
                  size={18}
                  weight="duotone"
                  className="text-teal-600 dark:text-teal-400"
                />
              ) : (
                <CheckCircle
                  size={18}
                  weight="duotone"
                  className="text-emerald-600 dark:text-emerald-400"
                />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3
                  className={cn(
                    'font-bold',
                    isMCP
                      ? 'text-teal-900 dark:text-teal-100'
                      : 'text-emerald-900 dark:text-emerald-100'
                  )}
                >
                  {isMCP ? 'MCP Tool Result' : 'Tool Execution Result'}
                </h3>
                <code
                  className={cn(
                    'rounded px-2 py-0.5 text-xs font-mono font-semibold',
                    isMCP
                      ? 'bg-teal-500/20 text-teal-800 dark:text-teal-200'
                      : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200'
                  )}
                >
                  {isMCP ? getMCPToolLabel(toolName) : toolName}
                </code>
                {isMCP && (
                  <span className="rounded-full bg-teal-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">
                    Supabase MCP
                  </span>
                )}
              </div>
              <p
                className={cn(
                  'text-xs mt-0.5',
                  isMCP
                    ? 'text-teal-700 dark:text-teal-300'
                    : 'text-emerald-700 dark:text-emerald-300'
                )}
              >
                Successfully completed
              </p>
            </div>
          </div>
        </div>

        {/* Tool Result Content */}
        <div className={isMCP ? 'bg-teal-500/5' : 'bg-emerald-500/5'}>
          <div className="p-4">
            <div
              className={cn(
                'text-xs font-semibold mb-2',
                isMCP
                  ? 'text-teal-800 dark:text-teal-300'
                  : 'text-emerald-800 dark:text-emerald-300'
              )}
            >
              Response:
            </div>
            {isJsonContent ? (
              <div
                className={cn(
                  'rounded-md border',
                  isMCP
                    ? 'bg-teal-950/10 dark:bg-teal-950/30 border-teal-500/20'
                    : 'bg-emerald-950/10 dark:bg-emerald-950/30 border-emerald-500/20'
                )}
              >
                <table
                  className={cn(
                    'min-w-full divide-y',
                    isMCP ? 'divide-teal-500/20' : 'divide-emerald-500/20'
                  )}
                >
                  <tbody
                    className={cn(
                      'divide-y',
                      isMCP ? 'divide-teal-500/20' : 'divide-emerald-500/20'
                    )}
                  >
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
                        <tr
                          key={argIdx}
                          className={isMCP ? 'hover:bg-teal-500/5' : 'hover:bg-emerald-500/5'}
                        >
                          <td
                            className={cn(
                              'px-3 py-2 text-sm font-medium whitespace-nowrap w-1/3',
                              isMCP
                                ? 'text-teal-900 dark:text-teal-100'
                                : 'text-emerald-900 dark:text-emerald-100'
                            )}
                          >
                            {key}
                          </td>
                          <td
                            className={cn(
                              'px-3 py-2 text-sm',
                              isMCP
                                ? 'text-teal-700 dark:text-teal-300'
                                : 'text-emerald-700 dark:text-emerald-300'
                            )}
                          >
                            {isComplexValue(value) ? (
                              <code
                                className={cn(
                                  'rounded px-2 py-1 font-mono text-xs break-all block whitespace-pre-wrap',
                                  isMCP ? 'bg-teal-500/10' : 'bg-emerald-500/10'
                                )}
                              >
                                {JSON.stringify(value, null, 2)}
                              </code>
                            ) : (
                              <span className="wrap-break-word">{String(value)}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <code
                className={cn(
                  'block text-sm whitespace-pre-wrap font-mono p-3 rounded-md border',
                  isMCP
                    ? 'text-teal-700 dark:text-teal-300 bg-teal-950/10 dark:bg-teal-950/30 border-teal-500/20'
                    : 'text-emerald-700 dark:text-emerald-300 bg-emerald-950/10 dark:bg-emerald-950/30 border-emerald-500/20'
                )}
              >
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
                'flex w-full items-center justify-center gap-1 border-t py-2.5',
                'text-sm font-medium transition-colors',
                isMCP
                  ? 'border-teal-500/30 text-teal-700 dark:text-teal-300 hover:bg-teal-500/10'
                  : 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10'
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
                  Show more (
                  {isJsonContent && Array.isArray(parsedContent)
                    ? `${parsedContent.length - 5} more items`
                    : 'full content'}
                  )
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
