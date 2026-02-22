/**
 * Integrations API Service
 *
 * Server-side operations for managing external integrations:
 * - List integrations and their sync status
 * - Trigger sync operations
 * - Get sync statistics
 */

// Integration summary from the API
export interface IntegrationSummary {
  id: string;
  provider: string;
  display_name: string | null;
  external_account_id: string;
  entity_id: string | null;
  sync_status: 'idle' | 'syncing' | 'error' | 'completed';
  sync_error: string | null;
  last_synced_at: string | null;
  entity_name: string | null;
  stats: Record<string, number> | null;
  api_key_status: 'pending' | 'valid' | 'invalid' | 'expired';
  api_key_last_validated_at: string | null;
  api_key_error: string | null;
  failed_events_count: number;
  uncategorized_transactions_count: number;
}

// Sync trigger response
export interface TriggerSyncResponse {
  source_id: string;
  status: string;
  message: string;
  event_ids: string[];
}

// Normalization trigger response
export interface TriggerNormalizeResponse {
  source_id: string;
  status: string;
  mode: 'hard' | 'soft';
  message: string;
  event_ids: string[];
}

// Normalization stats (from the normalization API)
export interface NormalizationStats {
  by_status: Record<string, number>;
  by_entity_type: Record<string, number>;
  by_status_and_type: Record<string, number>;
}

// API key validation response
export interface ValidateApiKeyResponse {
  source_id: string;
  status: 'valid' | 'invalid';
  message: string;
  provider: string;
}

// API key update response
export interface UpdateApiKeyResponse {
  source_id: string;
  status: string;
  message: string;
}

// Entity response
export interface Entity {
  id: string;
  name: string;
  currency: string;
  legal_name: string | null;
  country: string | null;
  created_at: string;
}

// External source (full details)
export interface ExternalSource {
  id: string;
  entity_id: string | null;
  provider: string;
  external_account_id: string;
  display_name: string | null;
  sync_status: string;
  sync_error: string | null;
  last_synced_at: string | null;
  sync_cursor: string | null;
  created_at: string;
  updated_at: string;
}

// Create external source request
export interface CreateExternalSourceRequest {
  entity_id: string;
  provider: string;
  external_account_id: string;
  display_name?: string;
  api_key: string;
}

// Get the AI Agent API base URL
function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    // Client-side
    // @ts-ignore
    return import.meta.env?.VITE_AI_AGENT_URL || 'http://localhost:8000';
  }
  // Server-side
  return process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:8000';
}

/**
 * Fetch the list of all integrations with their status
 *
 * @param entityId - Optional entity ID to filter by user's company
 */
export async function getIntegrationsSummary(entityId?: string): Promise<IntegrationSummary[]> {
  const baseUrl = getApiBaseUrl();
  const params = entityId ? `?entity_id=${entityId}` : '';

  try {
    const response = await fetch(`${baseUrl}/integrations/summary${params}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to fetch integrations:', response.status, errorText);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching integrations:', error);
    return [];
  }
}

/**
 * Get all entities
 */
export async function getEntities(): Promise<Entity[]> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/entities`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch entities:', response.status);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching entities:', error);
    return [];
  }
}

/**
 * Trigger a sync for an integration
 *
 * @param sourceId - The external source ID to sync
 * @param endpoint - Optional specific endpoint to sync (e.g., 'products', 'orders')
 */
export async function triggerSync(
  sourceId: string,
  endpoint?: string
): Promise<TriggerSyncResponse | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources/${sourceId}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to trigger sync:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error triggering sync:', error);
    return null;
  }
}

/**
 * Get sync statistics for a source
 */
export async function getSyncStats(
  sourceId: string
): Promise<{ stats: Record<string, number> } | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources/${sourceId}/stats`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch sync stats:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching sync stats:', error);
    return null;
  }
}

/**
 * Create a new external source connection
 */
export async function createExternalSource(
  request: CreateExternalSourceRequest
): Promise<ExternalSource | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to create external source:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error creating external source:', error);
    return null;
  }
}

/**
 * Create a new entity
 */
export async function createEntity(
  name: string,
  currency: string,
  legalName?: string,
  country?: string
): Promise<Entity | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/entities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        currency,
        legal_name: legalName,
        country,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to create entity:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error creating entity:', error);
    return null;
  }
}

/**
 * Validate the API key for an integration
 *
 * Tests the API key by making a request to the provider's API.
 * Updates the api_key_status in the database.
 *
 * @param sourceId - The external source ID to validate
 */
export async function validateApiKey(sourceId: string): Promise<ValidateApiKeyResponse | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources/${sourceId}/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to validate API key:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error validating API key:', error);
    return null;
  }
}

/**
 * Update the API key for an integration
 *
 * Stores the new key securely in Vault and resets validation status.
 *
 * @param sourceId - The external source ID to update
 * @param apiKey - The new API key
 */
export async function updateApiKey(
  sourceId: string,
  apiKey: string
): Promise<UpdateApiKeyResponse | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources/${sourceId}/api-key`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ api_key: apiKey }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to update API key:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error updating API key:', error);
    return null;
  }
}

/**
 * Trigger normalization for a source (the "Load Data" action)
 *
 * Processes synced raw events into canonical models (customers, orders, products, etc.)
 * Progress is streamed via Inngest Realtime on the normalization channel.
 *
 * @param sourceId - The external source ID to normalize
 * @param mode - 'soft' (default, only pending) or 'hard' (reset everything and reprocess)
 * @param batchSize - Number of events per batch (default 100)
 */
export async function triggerNormalization(
  sourceId: string,
  mode: 'hard' | 'soft' = 'soft',
  batchSize: number = 100
): Promise<TriggerNormalizeResponse | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources/${sourceId}/normalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode, batch_size: batchSize }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to trigger normalization:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error triggering normalization:', error);
    return null;
  }
}

/**
 * Get normalization processing stats for a source
 *
 * Returns counts by status, entity type, and combined status/type.
 *
 * @param sourceId - The external source ID to get stats for
 */
export async function getNormalizationStats(sourceId: string): Promise<NormalizationStats | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/normalization/stats?source_id=${sourceId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch normalization stats:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching normalization stats:', error);
    return null;
  }
}

/**
 * Trigger reprocessing of failed events for a source
 *
 * @param sourceId - Optional source ID to filter failed events
 * @param limit - Maximum number of failed events to reprocess (default 100)
 */
export async function reprocessFailedEvents(
  sourceId?: string,
  limit: number = 100
): Promise<{ status: string; message: string } | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const body = sourceId ? { source_id: sourceId, limit } : { limit };

    const response = await fetch(`${baseUrl}/normalization/reprocess-failed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to trigger reprocessing:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error triggering reprocessing:', error);
    return null;
  }
}

/**
 * Delete an external source and all associated data
 *
 * Cascades: raw events, Vault API key, source record.
 *
 * @param sourceId - The external source ID to delete
 */
export async function deleteExternalSource(
  sourceId: string
): Promise<{ source_id: string; status: string; events_deleted: number } | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/sources/${sourceId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to delete external source:', response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error deleting external source:', error);
    return null;
  }
}

// =============================================================================
// INCOMPLETE TRANSACTIONS
// =============================================================================

export interface IncompleteTransaction {
  id: string;
  source: string;
  external_transaction_id: string;
  transaction_type: string;
  amount: number;
  currency_code: string;
  direction: string;
  occurred_at: string;
  description: string | null;
  counterparty_name: string | null;
  metadata: Record<string, any> | null;
}

export interface IncompleteTransactionsResponse {
  transactions: IncompleteTransaction[];
  total_count: number;
}

export interface ChartOfAccountsEntry {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  normal_balance: string;
  is_header: boolean;
  department: string | null;
  tax_code: string | null;
  status: string;
}

export interface AISuggestion {
  transaction_id: string;
  suggested_account_number: string | null;
  suggested_expense_category: string | null;
  confidence: number;
  reasoning: string | null;
}

/**
 * Get incomplete transactions (missing chart_of_accounts assignment)
 */
export async function getIncompleteTransactions(
  sourceId?: string,
  limit: number = 50,
  offset: number = 0
): Promise<IncompleteTransactionsResponse | null> {
  const baseUrl = getApiBaseUrl();
  const params = new URLSearchParams();
  if (sourceId) params.set('source_id', sourceId);
  console.log(sourceId);

  params.set('limit', limit.toString());
  params.set('offset', offset.toString());

  try {
    const response = await fetch(`${baseUrl}/integrations/transactions/incomplete?${params}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      console.error('Failed to fetch incomplete transactions:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching incomplete transactions:', error);
    return null;
  }
}

/**
 * Assign an account_number to a transaction (stored in metadata)
 */
export async function updateTransactionCategory(
  transactionId: string,
  accountNumber: string
): Promise<{ status: string } | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/transactions/${transactionId}/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_number: accountNumber }),
    });

    if (!response.ok) {
      console.error('Failed to update transaction category:', response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error updating transaction category:', error);
    return null;
  }
}

/**
 * Get AI-suggested categories for transactions
 */
export async function aiCategorizeTransactions(
  transactionIds: string[]
): Promise<AISuggestion[] | null> {
  const baseUrl = getApiBaseUrl();

  try {
    const response = await fetch(`${baseUrl}/integrations/transactions/ai-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_ids: transactionIds }),
    });

    if (!response.ok) {
      console.error('Failed to get AI categories:', response.status);
      return null;
    }

    const data = await response.json();
    return data.suggestions;
  } catch (error) {
    console.error('Error getting AI categories:', error);
    return null;
  }
}

/**
 * Get chart of accounts entries
 */
export async function getChartOfAccounts(
  accountType?: string
): Promise<ChartOfAccountsEntry[]> {
  const baseUrl = getApiBaseUrl();
  const params = new URLSearchParams();
  if (accountType) params.set('account_type', accountType);

  try {
    const response = await fetch(`${baseUrl}/integrations/chart-of-accounts?${params}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      console.error('Failed to fetch chart of accounts:', response.status);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching chart of accounts:', error);
    return [];
  }
}
