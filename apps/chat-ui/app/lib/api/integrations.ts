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
  sync_status: 'idle' | 'syncing' | 'error' | 'completed';
  sync_error: string | null;
  last_synced_at: string | null;
  entity_name: string | null;
  stats: Record<string, number> | null;
  api_key_status: 'pending' | 'valid' | 'invalid' | 'expired';
  api_key_last_validated_at: string | null;
  api_key_error: string | null;
}

// Sync trigger response
export interface TriggerSyncResponse {
  source_id: string;
  status: string;
  message: string;
  event_ids: string[];
}

// API key validation response
export interface ValidateApiKeyResponse {
  source_id: string;
  status: 'valid' | 'invalid';
  message: string;
  provider: string;
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
