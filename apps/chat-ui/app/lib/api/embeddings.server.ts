/**
 * Embeddings API Service
 *
 * Server-side operations for embedding files via LangGraph:
 * - Send files to the embedding endpoint
 * - Track embedding status
 */

// Embedding request input
export interface EmbedFileInput {
  file_type: string;
  file_url: string;
}

// Embedding response from LangGraph
export interface EmbedFileResponse {
  success: boolean;
  message?: string;
  embedding_id?: string;
  error?: string;
}

// Get the LangGraph embeddings endpoint URL
function getEmbeddingsEndpoint(): string {
  return (
    process.env.LANGGRAPH_EMBEDDINGS_URL ||
    process.env.VITE_LANGGRAPH_EMBEDDINGS_URL ||
    'http://localhost:2024/embeddings/embed'
  );
}

/**
 * Embed a file by sending it to the LangGraph embeddings endpoint
 *
 * @param input - The file type and URL to embed
 * @returns The embedding response or error
 */
export async function embedFile(input: EmbedFileInput): Promise<EmbedFileResponse> {
  const endpoint = getEmbeddingsEndpoint();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_type: input.file_type,
        file_url: input.file_url,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Embedding request failed:', response.status, errorText);
      return {
        success: false,
        error: `Embedding failed with status ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      ...data,
    };
  } catch (error) {
    console.error('Error calling embeddings endpoint:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Embed an uploaded invoice file
 *
 * Convenience wrapper that extracts the file type from the MIME type
 * and constructs the appropriate file URL
 *
 * @param fileUrl - The Supabase signed URL or public URL of the file
 * @param mimeType - The MIME type of the file (e.g., 'application/pdf')
 * @returns The embedding response or error
 */
export async function embedInvoiceFile(
  fileUrl: string,
  mimeType: string = 'application/pdf'
): Promise<EmbedFileResponse> {
  // Extract file type from MIME type (e.g., 'application/pdf' -> 'pdf')
  const fileType = mimeType.split('/').pop() || 'pdf';

  return embedFile({
    file_type: fileType,
    file_url: fileUrl,
  });
}

/**
 * Batch embed multiple files
 *
 * @param files - Array of file inputs to embed
 * @returns Array of embedding responses
 */
export async function embedMultipleFiles(files: EmbedFileInput[]): Promise<EmbedFileResponse[]> {
  const results = await Promise.all(files.map(file => embedFile(file)));
  return results;
}
