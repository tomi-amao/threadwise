/**
 * ContentBlocksPreview Component
 *
 * Renders a preview of attached files (images, PDFs) before sending a message.
 * Shows thumbnails for images and file icons for PDFs with remove buttons.
 */

import React from 'react';
import { File, Image as ImageIcon, X } from 'phosphor-react';
import { cn } from '~/lib/utils';
import type { Base64ContentBlock } from '~/lib/multimodal-utils';

interface ContentBlocksPreviewProps {
  blocks: Base64ContentBlock[];
  onRemove: (idx: number) => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * MultimodalPreview - renders a single content block preview
 */
function MultimodalPreview({
  block,
  removable = false,
  onRemove,
  className,
  size = 'md',
}: {
  block: Base64ContentBlock;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  // Image block
  if (
    block.type === 'image' &&
    block.source_type === 'base64' &&
    typeof block.mime_type === 'string' &&
    block.mime_type.startsWith('image/')
  ) {
    const url = `data:${block.mime_type};base64,${block.data}`;
    const sizeClasses = {
      sm: 'h-10 w-10',
      md: 'h-16 w-16',
      lg: 'h-24 w-24',
    };

    return (
      <div className={cn('relative inline-block', className)}>
        <img
          src={url}
          alt={String(block.metadata?.name || 'uploaded image')}
          className={cn('rounded-md object-cover', sizeClasses[size])}
        />
        {removable && (
          <button
            type="button"
            className="absolute -top-1 -right-1 z-10 rounded-full bg-destructive text-destructive-foreground p-0.5 hover:bg-destructive/80 shadow-sm"
            onClick={onRemove}
            aria-label="Remove image"
          >
            <X size={12} weight="bold" />
          </button>
        )}
      </div>
    );
  }

  // PDF block
  if (
    block.type === 'file' &&
    block.source_type === 'base64' &&
    block.mime_type === 'application/pdf'
  ) {
    const filename = block.metadata?.filename || block.metadata?.name || 'PDF file';
    const sizeClasses = {
      sm: 'text-xs px-2 py-1',
      md: 'text-sm px-3 py-2',
      lg: 'text-base px-4 py-3',
    };
    const iconSize = size === 'sm' ? 16 : size === 'md' ? 20 : 24;

    return (
      <div
        className={cn(
          'relative flex items-center gap-2 rounded-md border border-border bg-muted/50',
          sizeClasses[size],
          className
        )}
      >
        <File size={iconSize} weight="duotone" className="text-primary shrink-0" />
        <span className="truncate max-w-[150px] text-foreground">{String(filename)}</span>
        {removable && (
          <button
            type="button"
            className="ml-1 rounded-full bg-muted p-0.5 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors"
            onClick={onRemove}
            aria-label="Remove PDF"
          >
            <X size={12} weight="bold" />
          </button>
        )}
      </div>
    );
  }

  // Fallback for unknown types
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-muted-foreground',
        className
      )}
    >
      <File size={16} className="shrink-0" />
      <span className="truncate text-xs">Unsupported file</span>
      {removable && (
        <button
          type="button"
          className="ml-1 rounded-full bg-muted p-0.5 hover:bg-destructive hover:text-destructive-foreground"
          onClick={onRemove}
          aria-label="Remove file"
        >
          <X size={12} weight="bold" />
        </button>
      )}
    </div>
  );
}

/**
 * ContentBlocksPreview - renders all content blocks with remove functionality
 */
export function ContentBlocksPreview({
  blocks,
  onRemove,
  size = 'md',
  className,
}: ContentBlocksPreviewProps) {
  if (!blocks.length) return null;

  return (
    <div className={cn('flex flex-wrap gap-2 pb-2', className)}>
      {blocks.map((block, idx) => (
        <MultimodalPreview
          key={idx}
          block={block}
          removable
          onRemove={() => onRemove(idx)}
          size={size}
        />
      ))}
    </div>
  );
}
