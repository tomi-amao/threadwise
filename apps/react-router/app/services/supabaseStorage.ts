/**
 * Supabase Storage Service
 *
 * Handles file uploads and retrieval using Supabase Storage
 * Integrates with embedding service for searchable document storage
 */

import { createClient } from '@supabase/supabase-js';
import { embedFile, type EmbeddingResult } from './embeddingService';
import { isSupportedFileType } from './textExtraction';

// Supabase configuration
const SUPABASE_URL = 'http://localhost:8000';
const SUPABASE_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q';

// Create Supabase client
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Storage bucket name for chat attachments
const BUCKET_NAME = 'chat-attachments';

// Maximum file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  publicUrl: string;
  embedding?: EmbeddingResult;
}

export interface UploadResult {
  success: boolean;
  fileName: string;
  publicUrl: string;
  originalName: string;
  size: number;
  mimeType: string;
  embedding?: EmbeddingResult;
  error?: string;
}

/**
 * Initialize storage bucket (call this once to set up the bucket)
 */
export async function initializeStorage(): Promise<boolean> {
  console.log('🔧 Initializing Supabase storage...');

  try {
    console.log('📋 Checking if bucket exists...');
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      console.error('❌ Error listing buckets:', listError);
      console.warn('⚠️ Cannot list buckets, but storage might still work for existing buckets');
      // Don't return false here - storage might still work for existing buckets
    } else {
      console.log('📦 Available buckets:', buckets?.map(b => b.name) || []);
      const bucketExists = buckets?.some(bucket => bucket.name === BUCKET_NAME);
      console.log(`🔍 Bucket "${BUCKET_NAME}" exists:`, bucketExists);

      if (bucketExists) {
        console.log('✅ Bucket already exists, storage ready!');
        return true;
      }
    }

    // Only try to create bucket if we could list buckets and it doesn't exist
    if (!listError) {
      console.log(`🚀 Attempting to create bucket "${BUCKET_NAME}"...`);
      console.log(
        '⚠️ Note: This might fail due to RLS policies. You may need to create the bucket manually.'
      );

      const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: true,
        allowedMimeTypes: [
          'text/plain',
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'text/markdown',
          'application/json',
          'text/csv',
          'text/xml',
          'application/xml',
        ],
        fileSizeLimit: 10485760, // 10MB
      });

      if (error) {
        console.error('❌ Error creating bucket:', error);
        console.warn(
          '⚠️ Bucket creation failed. You need to create the bucket manually in Supabase Studio.'
        );
        console.warn(`📝 To fix this:`);
        console.warn(`   1. Go to http://localhost:3000 (Supabase Studio)`);
        console.warn(`   2. Navigate to Storage > Settings`);
        console.warn(`   3. Create a new bucket named "${BUCKET_NAME}"`);
        console.warn(`   4. Make it public and set appropriate policies`);
        return false;
      }

      console.log('✅ Bucket created successfully!');
    }

    return true;
  } catch (error) {
    console.error('💥 Error initializing storage:', error);
    console.warn('⚠️ Storage initialization failed, but uploads might still work if bucket exists');
    return false;
  }
}

/**
 * Upload file to Supabase Storage
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  console.log(`📤 Starting upload for file: ${file.name} (${file.size} bytes)`);

  try {
    // Validate file
    console.log('� Validating file...');
    if (file.size > MAX_FILE_SIZE) {
      const error = new Error(`File too large: ${file.size} bytes (max: ${MAX_FILE_SIZE})`);
      console.error('❌ File validation failed:', error.message);
      throw error;
    }
    console.log('✅ File validation passed');

    // Generate unique filename
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 15);
    const fileExtension = file.name.split('.').pop() || '';
    const fileName = `${timestamp}-${randomId}.${fileExtension}`;
    console.log(`📝 Generated filename: ${fileName}`);

    console.log(`� Uploading to bucket "${BUCKET_NAME}"...`);

    // Upload file
    const { data, error } = await supabase.storage.from(BUCKET_NAME).upload(fileName, file, {
      cacheControl: '3600',
      upsert: false,
    });

    if (error) {
      console.error('❌ Upload failed:', error);

      // Provide specific error messages for common issues
      if (error.message?.includes('bucket') && error.message?.includes('not found')) {
        throw new Error(
          `Bucket "${BUCKET_NAME}" not found. Please create it manually in Supabase Studio.`
        );
      } else if (
        error.message?.includes('row-level security') ||
        error.message?.includes('policy')
      ) {
        throw new Error(
          'Upload failed due to security policies. Please check your Supabase RLS settings.'
        );
      } else {
        throw new Error(`Upload failed: ${error.message}`);
      }
    }

    console.log('✅ File uploaded successfully!');
    console.log('� Upload data:', data);

    // Get public URL
    console.log('🔗 Generating public URL...');
    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);

    if (!publicUrlData?.publicUrl) {
      console.error('❌ Failed to get public URL');
      throw new Error('Failed to get public URL for uploaded file');
    }

    console.log('✅ Public URL generated:', publicUrlData.publicUrl);

    // Create embeddings for supported file types
    let embeddingResult: EmbeddingResult | undefined;
    if (isSupportedFileType(file.type)) {
      console.log('🧠 File type supports text extraction, creating embeddings...');
      try {
        embeddingResult = await embedFile(file, publicUrlData.publicUrl);
        if (embeddingResult.success) {
          console.log(`✅ Successfully created ${embeddingResult.chunks} embedding chunks`);
        } else {
          console.warn('⚠️ Embedding creation failed:', embeddingResult.error);
        }
      } catch (embeddingError) {
        console.warn('⚠️ Error creating embeddings:', embeddingError);
        // Don't fail the upload if embedding fails
      }
    } else {
      console.log('📄 File type not supported for text extraction, skipping embeddings');
    }

    const result: UploadResult = {
      success: true,
      fileName: data.path,
      publicUrl: publicUrlData.publicUrl,
      originalName: file.name,
      size: file.size,
      mimeType: file.type,
      embedding: embeddingResult,
    };

    console.log('🎉 Upload completed successfully:', {
      ...result,
      embedding: embeddingResult
        ? {
            documentId: embeddingResult.documentId,
            chunks: embeddingResult.chunks,
            success: embeddingResult.success,
          }
        : undefined,
    });
    return result;
  } catch (error) {
    console.error('💥 Upload error:', error);

    const result: UploadResult = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown upload error',
      fileName: '',
      publicUrl: '',
      originalName: file.name,
      size: file.size,
      mimeType: file.type,
    };

    console.log('💔 Upload failed with result:', result);
    return result;
  }
}

/**
 * Upload multiple files
 */
export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  console.log(`📦 Starting batch upload of ${files.length} file(s)...`);
  console.log(
    '📋 Files to upload:',
    files.map(f => ({ name: f.name, size: f.size, type: f.type }))
  );

  const uploadPromises = files.map((file, index) => {
    console.log(`🚀 Starting upload ${index + 1}/${files.length}: ${file.name}`);
    return uploadFile(file);
  });

  const results = await Promise.allSettled(uploadPromises);

  console.log(
    '📊 Upload results:',
    results.map((result, index) => ({
      file: files[index].name,
      status: result.status,
      success: result.status === 'fulfilled' && result.value.success,
    }))
  );

  const successfulUploads = results
    .filter(
      (result): result is PromiseFulfilledResult<UploadResult> =>
        result.status === 'fulfilled' && result.value.success
    )
    .map(result => {
      const uploadResult = result.value;
      return {
        id: uploadResult.fileName,
        name: uploadResult.originalName,
        size: uploadResult.size,
        type: uploadResult.mimeType,
        url: uploadResult.publicUrl,
        publicUrl: uploadResult.publicUrl,
        embedding: uploadResult.embedding,
      } as UploadedFile;
    });

  console.log(`✅ Successfully uploaded ${successfulUploads.length}/${files.length} files`);

  return successfulUploads;
}

/**
 * Delete a file from storage and its embeddings
 */
export async function deleteFile(filePath: string, originalFileName?: string): Promise<boolean> {
  try {
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([filePath]);

    if (error) {
      console.error('Delete error:', error);
      return false;
    }

    // Also delete embeddings if we have the original filename
    if (originalFileName) {
      console.log(`🗑️ Deleting embeddings for: ${originalFileName}`);
      try {
        const { deleteDocumentsByFileName } = await import('./embeddingService');
        await deleteDocumentsByFileName(originalFileName);
        console.log(`✅ Embeddings deleted for: ${originalFileName}`);
      } catch (embeddingError) {
        console.warn(`⚠️ Failed to delete embeddings for ${originalFileName}:`, embeddingError);
        // Don't fail the file deletion if embedding deletion fails
      }
    }

    return true;
  } catch (error) {
    console.error('Error deleting file:', error);
    return false;
  }
}

/**
 * Get file URL for viewing/downloading
 */
export function getFileUrl(filePath: string): string {
  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);

  return data.publicUrl;
}

/**
 * Check if storage is accessible
 */
export async function checkStorageHealth(): Promise<boolean> {
  console.log('🏥 Checking Supabase storage health...');

  try {
    // Try to list buckets as a basic connectivity test
    console.log('� Testing storage connectivity...');
    const { data, error } = await supabase.storage.listBuckets();

    if (error) {
      console.error('❌ Storage health check failed:', error);
      // If we can't list buckets due to RLS, that's ok - storage might still work
      if (error.message?.includes('row-level security') || error.message?.includes('policy')) {
        console.warn('⚠️ Cannot list buckets due to RLS policies, but storage might still work');
        console.warn('💡 Try uploading a file to test if the bucket exists');
        return true; // Return true because storage might still work for uploads
      }
      return false;
    }

    console.log('✅ Storage health check passed');
    console.log('📦 Available buckets:', data?.map(b => b.name) || []);

    // Check if our specific bucket exists
    const bucketExists = data?.some(bucket => bucket.name === BUCKET_NAME);
    console.log(`🔍 Target bucket "${BUCKET_NAME}" exists:`, bucketExists);

    if (!bucketExists) {
      console.warn(`⚠️ Bucket "${BUCKET_NAME}" not found. You may need to create it manually.`);
    }

    return true;
  } catch (error) {
    console.error('💥 Storage health check error:', error);
    return false;
  }
}
