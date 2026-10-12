/**
 * useFileUpload Hook
 *
 * Custom hook for handling file uploads in the chat interface.
 * Supports drag-and-drop, paste, and file input upload methods.
 * Handles images (JPEG, PNG, GIF, WEBP) and PDFs.
 */

import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { toast } from 'sonner';
import {
  Base64ContentBlock,
  SUPPORTED_FILE_TYPES,
  fileToContentBlock,
  isDuplicateFile,
} from '~/lib/multimodal-utils';

interface UseFileUploadOptions {
  initialBlocks?: Base64ContentBlock[];
}

export function useFileUpload({ initialBlocks = [] }: UseFileUploadOptions = {}) {
  const [contentBlocks, setContentBlocks] = useState<Base64ContentBlock[]>(initialBlocks);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  /**
   * Handle file input change event
   */
  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(file => SUPPORTED_FILE_TYPES.includes(file.type));
    const invalidFiles = fileArray.filter(file => !SUPPORTED_FILE_TYPES.includes(file.type));
    const duplicateFiles = validFiles.filter(file => isDuplicateFile(file, contentBlocks));
    const uniqueFiles = validFiles.filter(file => !isDuplicateFile(file, contentBlocks));

    if (invalidFiles.length > 0) {
      toast.error('Invalid file type. Please upload a JPEG, PNG, GIF, WEBP image or a PDF.');
    }
    if (duplicateFiles.length > 0) {
      toast.error(
        `Duplicate file(s) detected: ${duplicateFiles.map(f => f.name).join(', ')}. Each file can only be uploaded once per message.`
      );
    }

    const newBlocks = uniqueFiles.length
      ? await Promise.all(uniqueFiles.map(fileToContentBlock))
      : [];
    setContentBlocks(prev => [...prev, ...newBlocks]);
    e.target.value = '';
  };

  // Drag and drop handlers
  useEffect(() => {
    if (!dropRef.current) return;

    const handleWindowDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        dragCounter.current += 1;
        setDragOver(true);
      }
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
          setDragOver(false);
          dragCounter.current = 0;
        }
      }
    };

    const handleWindowDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragOver(false);

      if (!e.dataTransfer) return;

      const files = Array.from(e.dataTransfer.files);
      const validFiles = files.filter(file => SUPPORTED_FILE_TYPES.includes(file.type));
      const invalidFiles = files.filter(file => !SUPPORTED_FILE_TYPES.includes(file.type));
      const duplicateFiles = validFiles.filter(file => isDuplicateFile(file, contentBlocks));
      const uniqueFiles = validFiles.filter(file => !isDuplicateFile(file, contentBlocks));

      if (invalidFiles.length > 0) {
        toast.error('Invalid file type. Please upload a JPEG, PNG, GIF, WEBP image or a PDF.');
      }
      if (duplicateFiles.length > 0) {
        toast.error(
          `Duplicate file(s) detected: ${duplicateFiles.map(f => f.name).join(', ')}. Each file can only be uploaded once per message.`
        );
      }

      const newBlocks = uniqueFiles.length
        ? await Promise.all(uniqueFiles.map(fileToContentBlock))
        : [];
      setContentBlocks(prev => [...prev, ...newBlocks]);
    };

    const handleWindowDragEnd = () => {
      dragCounter.current = 0;
      setDragOver(false);
    };

    const handleWindowDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('dragend', handleWindowDragEnd);
    window.addEventListener('dragover', handleWindowDragOver);

    // Element-specific handlers
    const element = dropRef.current;
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    };
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
    };

    element.addEventListener('dragover', handleDragOver);
    element.addEventListener('dragenter', handleDragEnter);
    element.addEventListener('dragleave', handleDragLeave);

    return () => {
      element.removeEventListener('dragover', handleDragOver);
      element.removeEventListener('dragenter', handleDragEnter);
      element.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('dragend', handleWindowDragEnd);
      window.removeEventListener('dragover', handleWindowDragOver);
      dragCounter.current = 0;
    };
  }, [contentBlocks]);

  /**
   * Remove a block by index
   */
  const removeBlock = (idx: number) => {
    setContentBlocks(prev => prev.filter((_, i) => i !== idx));
  };

  /**
   * Reset all blocks
   */
  const resetBlocks = () => setContentBlocks([]);

  /**
   * Handle paste event for files (images, PDFs)
   */
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const items = e.clipboardData.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0) return;
    e.preventDefault();

    const validFiles = files.filter(file => SUPPORTED_FILE_TYPES.includes(file.type));
    const invalidFiles = files.filter(file => !SUPPORTED_FILE_TYPES.includes(file.type));
    const duplicateFiles = validFiles.filter(file => isDuplicateFile(file, contentBlocks));
    const uniqueFiles = validFiles.filter(file => !isDuplicateFile(file, contentBlocks));

    if (invalidFiles.length > 0) {
      toast.error('Invalid file type. Please paste a JPEG, PNG, GIF, WEBP image or a PDF.');
    }
    if (duplicateFiles.length > 0) {
      toast.error(
        `Duplicate file(s) detected: ${duplicateFiles.map(f => f.name).join(', ')}. Each file can only be uploaded once per message.`
      );
    }
    if (uniqueFiles.length > 0) {
      const newBlocks = await Promise.all(uniqueFiles.map(fileToContentBlock));
      setContentBlocks(prev => [...prev, ...newBlocks]);
    }
  };

  return {
    contentBlocks,
    setContentBlocks,
    handleFileUpload,
    dropRef,
    removeBlock,
    resetBlocks,
    dragOver,
    handlePaste,
  };
}
