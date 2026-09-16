/**
 * Multimodal Utilities
 *
 * Utilities for handling multimodal content (images, PDFs) in chat messages.
 * Provides file-to-base64 conversion and content block creation.
 */

import { toast } from 'sonner';

// Base64 content block types following LangChain format
export interface Base64ContentBlock {
  type: 'image' | 'file' | 'text';
  source_type?: 'base64' | 'url';
  mime_type?: string;
  data?: string;
  text?: string;
  metadata?: {
    name?: string;
    filename?: string;
  };
}

// Supported file types for upload
export const SUPPORTED_FILE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
];

/**
 * Convert a File to base64 string
 */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove the data:...;base64, prefix
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Convert a File to a Base64ContentBlock
 */
export async function fileToContentBlock(file: File): Promise<Base64ContentBlock> {
  const supportedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const supportedFileTypes = [...supportedImageTypes, 'application/pdf'];

  if (!supportedFileTypes.includes(file.type)) {
    toast.error(
      `Unsupported file type: ${file.type}. Supported types are: ${supportedFileTypes.join(', ')}`
    );
    return Promise.reject(new Error(`Unsupported file type: ${file.type}`));
  }

  const data = await fileToBase64(file);

  if (supportedImageTypes.includes(file.type)) {
    return {
      type: 'image',
      source_type: 'base64',
      mime_type: file.type,
      data,
      metadata: { name: file.name },
    };
  }

  // PDF
  return {
    type: 'file',
    source_type: 'base64',
    mime_type: 'application/pdf',
    data,
    metadata: { filename: file.name },
  };
}

/**
 * Type guard for Base64ContentBlock
 */
export function isBase64ContentBlock(block: unknown): block is Base64ContentBlock {
  if (typeof block !== 'object' || block === null || !('type' in block)) return false;

  const typedBlock = block as { type: unknown; source_type?: unknown; mime_type?: unknown };

  // file type (PDF)
  if (
    typedBlock.type === 'file' &&
    typedBlock.source_type === 'base64' &&
    typeof typedBlock.mime_type === 'string' &&
    (typedBlock.mime_type.startsWith('image/') || typedBlock.mime_type === 'application/pdf')
  ) {
    return true;
  }

  // image type
  if (
    typedBlock.type === 'image' &&
    typedBlock.source_type === 'base64' &&
    typeof typedBlock.mime_type === 'string' &&
    typedBlock.mime_type.startsWith('image/')
  ) {
    return true;
  }

  return false;
}

/**
 * Get display name from a content block
 */
export function getBlockDisplayName(block: Base64ContentBlock): string {
  if (block.metadata?.filename) return block.metadata.filename;
  if (block.metadata?.name) return block.metadata.name;
  if (block.type === 'file') return 'PDF file';
  if (block.type === 'image') return 'Image';
  return 'Unknown file';
}

/**
 * Check if a file is a duplicate in the blocks list
 */
export function isDuplicateFile(file: File, blocks: Base64ContentBlock[]): boolean {
  if (file.type === 'application/pdf') {
    return blocks.some(
      b =>
        b.type === 'file' && b.mime_type === 'application/pdf' && b.metadata?.filename === file.name
    );
  }
  if (SUPPORTED_FILE_TYPES.includes(file.type)) {
    return blocks.some(
      b => b.type === 'image' && b.metadata?.name === file.name && b.mime_type === file.type
    );
  }
  return false;
}
