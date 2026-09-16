import React, { useCallback, useState } from 'react';
import { CloudArrowUp, File, X, Warning } from 'phosphor-react';
import type { UploadProgress, InvoiceType } from '~/types/invoice';

interface InvoiceUploadProps {
  onUpload: (files: File[], invoiceType: InvoiceType) => Promise<void>;
  isUploading: boolean;
  uploadProgress: UploadProgress[];
}

/**
 * InvoiceUpload Component
 *
 * Drag-and-drop zone for uploading PDF invoices
 * Features:
 * - Drag and drop support
 * - Click to browse files
 * - Multiple file selection
 * - Upload progress display
 * - PDF and image file validation
 */
export function InvoiceUpload({ onUpload, isUploading, uploadProgress }: InvoiceUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('PURCHASE');

  const validateFiles = (files: FileList | File[]): File[] => {
    const validFiles: File[] = [];
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
        setError(
          `"${file.name}" is not a PDF or image file. Only PDF and image files are allowed.`
        );
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(`"${file.name}" exceeds 10MB limit.`);
        continue;
      }
      validFiles.push(file);
    }

    return validFiles;
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      setError(null);

      const validFiles = validateFiles(e.dataTransfer.files);
      if (validFiles.length > 0) {
        await onUpload(validFiles, invoiceType);
      }
    },
    [onUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      if (e.target.files && e.target.files.length > 0) {
        const validFiles = validateFiles(e.target.files);
        if (validFiles.length > 0) {
          await onUpload(validFiles, invoiceType);
        }
      }
      // Reset input to allow re-uploading same file
      e.target.value = '';
    },
    [onUpload]
  );

  return (
    <div className="space-y-4">
      {/* Invoice Type Selector */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-foreground">Invoice Type</label>
        <div className="flex gap-2">
          {(['PURCHASE', 'SALE'] as InvoiceType[]).map(type => (
            <button
              key={type}
              type="button"
              disabled={isUploading}
              onClick={() => setInvoiceType(type)}
              className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold border-2 transition-all disabled:opacity-50 ${
                invoiceType === type
                  ? type === 'SALE'
                    ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                    : 'border-orange-500 bg-orange-500/15 text-orange-400'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/30'
              }`}
            >
              {type === 'SALE' ? 'Sale (money in)' : 'Purchase (money out)'}
            </button>
          ))}
        </div>
      </div>

      {/* Drop Zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          relative border-2 border-dashed rounded-xl p-8 text-center
          transition-all duration-200 cursor-pointer
          ${
            isDragOver
              ? 'border-primary bg-primary/10 scale-[1.02]'
              : 'border-border hover:border-primary/50 hover:bg-muted/50'
          }
          ${isUploading ? 'opacity-50 pointer-events-none' : ''}
        `}
      >
        <input
          type="file"
          accept="application/pdf, image/*"
          multiple
          onChange={handleFileInput}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          disabled={isUploading}
        />

        <div className="flex flex-col items-center gap-3">
          <div
            className={`
            p-4 rounded-full transition-colors
            ${isDragOver ? 'bg-primary/20' : 'bg-muted'}
          `}
          >
            <CloudArrowUp
              size={40}
              weight="duotone"
              className={isDragOver ? 'text-primary' : 'text-muted-foreground'}
            />
          </div>

          <div>
            <p className="font-medium text-foreground">
              {isDragOver ? 'Drop your invoices here' : 'Upload invoices'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Drag and drop PDF or Image files or click to browse
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              PDF and image files only, max 10MB each
            </p>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
          <Warning size={18} weight="bold" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto hover:bg-destructive/20 p-1 rounded"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Upload Progress */}
      {uploadProgress.length > 0 && (
        <div className="space-y-2">
          {uploadProgress.map((item, index) => (
            <div key={index} className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <File size={20} className="text-primary" weight="duotone" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.fileName}</p>
                <div className="flex items-center gap-2 mt-1">
                  {item.status === 'error' ? (
                    <span className="text-xs text-destructive">{item.error}</span>
                  ) : (
                    <>
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${
                            item.status === 'complete' ? 'bg-green-500' : 'bg-primary'
                          }`}
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {item.status === 'complete'
                          ? 'Done'
                          : item.status === 'processing'
                            ? 'Processing...'
                            : `${item.progress}%`}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
