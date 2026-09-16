# Secure API Key Management & External Data Sync Workflow

## Overview

ThreadWise implements a secure, end-to-end workflow for managing external service API keys and synchronizing data from third-party platforms (Squarespace, Revolut, etc.). This document explains the complete architecture from credential storage to data synchronization.

## Architecture Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                         │
│  - User enters API key in AddIntegrationForm                    │
│  - Displays API key validation status                           │
│  - Triggers syncs with visual feedback                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTPS (API Key in request body)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend API (FastAPI)                         │
│  - POST /integrations/sources (create & store)                  │
│  - POST /integrations/sources/{id}/validate (test key)          │
│  - POST /integrations/sources/{id}/sync (trigger)               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              Supabase Vault (Encrypted Storage)                  │
│  - vault.secrets table (encrypted at rest)                      │
│  - RLS policies enforce entity-level access                     │
│  - SECURITY DEFINER functions for server-only access            │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              Inngest (Background Jobs)                           │
│  - Orchestrates multi-step sync workflows                       │
│  - Retrieves API keys from Vault at runtime                     │
│  - Handles retries, rate limiting, pagination                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│           External APIs (Squarespace, Revolut)                   │
│  - Products, Orders, Transactions, etc.                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Secure API Key Storage

### Frontend: User Input

When a user adds a new integration, they provide their API key through the `AddIntegrationForm` component:

**Location**: `apps/chat-ui/app/routes/app.integrations.tsx`

```typescript
// User fills in the form
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  const result = await createExternalSource({
    entity_id: entity.id, // User's company/entity
    provider: 'squarespace', // or 'revolut'
    external_account_id: siteId, // Store/Account ID
    api_key: apiKey, // ⚠️ Sensitive credential
    display_name: displayName, // Optional friendly name
  });
};
```

**Key Points**:

- API key is sent via HTTPS POST request body (never in URL/query params)
- Only transmitted once during initial setup
- Frontend never stores or caches the API key

---

### Backend: Vault Storage

The backend receives the API key and immediately stores it in Supabase Vault:

**Location**: `apps/ai_agent/src/ai_agent/api/routes/integrations.py`

```python
@router.post("/sources", response_model=ExternalSourceResponse)
async def create_external_source(request: CreateExternalSourceRequest):
    """Create a new external source connection."""
    credentials = {"api_key": request.api_key}

    result = await sync_service.create_external_source(
        entity_id=request.entity_id,
        provider=request.provider,
        external_account_id=request.external_account_id,
        credentials=credentials,  # ⚠️ Contains sensitive API key
        display_name=request.display_name
    )

    return result
```

**Service Layer**: `apps/ai_agent/src/ai_agent/services/external_sync_service.py`

```python
async def create_external_source(
    self,
    entity_id: str,
    provider: str,
    external_account_id: str,
    credentials: Dict[str, Any],
    display_name: Optional[str] = None
) -> Dict[str, Any]:
    """Create external source and store API key in Vault."""

    # 1. Create the source record (no sensitive data)
    data = {
        "entity_id": str(entity_id),
        "provider": provider,
        "external_account_id": external_account_id,
        "display_name": display_name,
        "sync_status": "idle",
        "api_key_status": "pending",  # Will be validated later
    }

    result = await asyncio.to_thread(
        lambda: self.client.table("external_sources").insert(data).execute()
    )
    source = result.data[0]

    # 2. Store API key securely in Vault using RPC function
    api_key = credentials.get("api_key")
    if api_key:
        try:
            await asyncio.to_thread(
                lambda: self.client.rpc(
                    "store_api_key_secure",  # ← SECURITY DEFINER function
                    {
                        "p_source_id": source["id"],
                        "p_api_key": api_key,
                        "p_provider": provider
                    }
                ).execute()
            )
            logger.info(f"Stored API key securely for source {source['id']}")
        except Exception as e:
            logger.error(f"Failed to store API key in Vault: {e}")
            raise

    return source
```

**Key Points**:

- API key is **never stored in plain text** in the `external_sources` table
- Uses `asyncio.to_thread()` to avoid blocking the event loop
- Calls `store_api_key_secure()` - a Postgres function that handles Vault encryption

---

### Database: Vault Functions

**Migration**: `infrastructure/supabase/migrations/add_secure_api_key_vault.sql`

The Vault integration uses three secure functions:

#### 1. Store API Key (Encrypted)

```sql
CREATE OR REPLACE FUNCTION store_api_key_secure(
  p_source_id UUID,
  p_api_key TEXT,
  p_provider TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER  -- Runs with elevated privileges
AS $$
DECLARE
  v_secret_id UUID;
BEGIN
  -- Create encrypted secret in Vault
  v_secret_id := vault.create_secret(
    p_api_key,
    CONCAT('external_source_', p_provider, '_', p_source_id::TEXT)
  );

  -- Store secret reference in external_sources
  UPDATE external_sources
  SET
    api_key_secret_id = v_secret_id,
    updated_at = NOW()
  WHERE id = p_source_id;

  RETURN v_secret_id;
END;
$$;
```

#### 2. Get API Key (Decrypted - Server Only)

```sql
CREATE OR REPLACE FUNCTION get_api_key_secure(
  p_source_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER  -- Critical: Only server can call this
AS $$
DECLARE
  v_secret_id UUID;
  v_decrypted_key TEXT;
BEGIN
  -- Get the secret ID
  SELECT api_key_secret_id INTO v_secret_id
  FROM external_sources
  WHERE id = p_source_id;

  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Decrypt from Vault
  SELECT decrypted_secret INTO v_decrypted_key
  FROM vault.decrypted_secrets
  WHERE id = v_secret_id;

  RETURN v_decrypted_key;
END;
$$;
```

#### 3. Update Validation Status

```sql
CREATE OR REPLACE FUNCTION update_api_key_status(
  p_source_id UUID,
  p_status TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE external_sources
  SET
    api_key_status = p_status,
    api_key_last_validated_at = CASE
      WHEN p_status = 'valid' THEN NOW()
      ELSE api_key_last_validated_at
    END,
    api_key_error = p_error,
    updated_at = NOW()
  WHERE id = p_source_id;
END;
$$;
```

**Security Features**:

- `SECURITY DEFINER`: Functions run with database owner privileges (not user's)
- Only accessible via service role (backend only)
- Row-Level Security (RLS) filters by `entity_id` → `entities.owner_user_id = auth.uid()`
- Vault automatically encrypts secrets at rest

---

## 2. API Key Validation

Before using an API key, the system validates it by making a test request to the provider's API.

### Triggering Validation

**Frontend**:

```typescript
const handleValidateApiKey = async (sourceId: string) => {
  toast.loading('Validating API key...', { id: `validate-${sourceId}` });

  try {
    await validateApiKey(sourceId); // ← API call
    await fetchData(); // Refresh to show new status
    toast.success('API key validated successfully');
  } catch (error) {
    toast.error('Failed to validate API key');
  }
};
```

**Backend API**: `POST /integrations/sources/{source_id}/validate`

```python
@router.post("/sources/{source_id}/validate")
async def validate_api_key(source_id: str):
    """Validate the API key by making a test request to the provider."""

    # Get the source
    source = await sync_service.get_external_source(source_id)
    provider = source.get("provider", "unknown")

    # Retrieve API key from Vault (server-side only)
    api_key = await sync_service.get_api_key(source_id)

    if not api_key:
        await sync_service.update_api_key_status(
            source_id, "invalid", "No API key configured"
        )
        return ValidateApiKeyResponse(
            source_id=source_id,
            status="invalid",
            message="No API key configured",
            provider=provider
        )

    # Test the API key with provider
    if provider == "squarespace":
        is_valid, error_message = await _validate_squarespace_api_key(api_key)
    elif provider == "revolut":
        is_valid, error_message = await _validate_revolut_api_key(api_key)

    # Update status in database
    if is_valid:
        await sync_service.update_api_key_status(source_id, "valid")
    else:
        await sync_service.update_api_key_status(source_id, "invalid", error_message)

    return ValidateApiKeyResponse(
        source_id=source_id,
        status="valid" if is_valid else "invalid",
        message=error_message or "API key is valid",
        provider=provider
    )
```

**Validation Functions**:

```python
async def _validate_squarespace_api_key(api_key: str) -> tuple[bool, Optional[str]]:
    """Test API key by calling a lightweight Squarespace endpoint."""
    import httpx

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://api.squarespace.com/1.0/commerce/inventory",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": "ThreadWise/1.0"
                },
                params={"limit": 1},
                timeout=10.0
            )

            if response.status_code == 200:
                return True, None
            elif response.status_code == 401:
                return False, "Invalid API key - authentication failed"
            elif response.status_code == 403:
                return False, "API key lacks required permissions"
            else:
                return False, f"API returned status {response.status_code}"
    except httpx.TimeoutException:
        return False, "Request timed out"
    except Exception as e:
        return False, f"Connection error: {str(e)}"
```

**Key Points**:

- Validation happens on-demand (user-triggered or automatic)
- Makes a real API call to verify credentials work
- Updates `api_key_status`: `pending` → `valid` or `invalid`
- Error messages are user-friendly and actionable

---

## 3. Data Synchronization

Once an API key is validated, users can trigger data syncs to import external data.

### Triggering a Sync

**Frontend**:

```typescript
const handleSync = async (sourceId: string, endpoint?: string) => {
  setSyncingIds(prev => new Set([...prev, sourceId]));

  if (endpoint) {
    toast.loading(`Syncing ${endpoint}...`, { id: `sync-${sourceId}-${endpoint}` });
  } else {
    toast.loading('Syncing all data...', { id: `sync-${sourceId}` });
  }

  try {
    await triggerSync(sourceId, endpoint); // ← Triggers Inngest event
    await fetchData(); // Refresh UI
    toast.success('Sync completed successfully');
  } catch (error) {
    toast.error('Failed to sync data');
  } finally {
    setSyncingIds(prev => {
      const next = new Set(prev);
      next.delete(sourceId);
      return next;
    });
  }
};
```

**Backend API**: `POST /integrations/sources/{source_id}/sync`

```python
@router.post("/sources/{source_id}/sync")
async def trigger_sync(source_id: str, request: Optional[TriggerSyncRequest] = None):
    """Trigger a background sync via Inngest."""

    # Verify source exists
    source = await sync_service.get_external_source(source_id)
    if not source:
        raise HTTPException(404, "External source not found")

    # Check if already syncing
    if source.get("sync_status") == "syncing":
        raise HTTPException(409, "Sync already in progress")

    # Get Inngest client
    inngest_client = get_client()

    # Send event to trigger background job
    if request and request.endpoint:
        # Single endpoint sync
        event_ids = await inngest_client.send({
            "name": "squarespace/sync.endpoint",
            "data": {
                "source_id": source_id,
                "endpoint": request.endpoint  # e.g., "products", "orders"
            }
        })
        message = f"Triggered sync for {request.endpoint}"
    else:
        # Full sync (all endpoints)
        event_ids = await inngest_client.send({
            "name": "squarespace/sync.requested",
            "data": {"source_id": source_id}
        })
        message = "Triggered full sync for all endpoints"

    return TriggerSyncResponse(
        source_id=source_id,
        status="triggered",
        message=message,
        event_ids=event_ids if event_ids else []
    )
```

**Key Points**:

- Syncs are **asynchronous** - API returns immediately
- Uses Inngest for reliable background job execution
- Supports full sync or individual endpoint sync
- Frontend polls for status updates

---

### Inngest Background Jobs

**Location**: `apps/ai_agent/src/ai_agent/integrations/inngest/sync_functions.py`

#### Full Sync Orchestration

```python
@inngest_client.create_function(
    fn_id="squarespace_sync_all",
    trigger=inngest.TriggerEvent(event="squarespace/sync.requested"),
    retries=3,
)
async def squarespace_sync_all(ctx: inngest.Context) -> Dict[str, Any]:
    """Orchestrate a full sync across all endpoints."""

    source_id = ctx.event.data.get("source_id")

    # Update status to 'syncing'
    await sync_service.update_sync_status(source_id, "syncing")

    # Sync each endpoint sequentially
    results = {}
    for endpoint in ["products", "orders", "inventory", "transactions"]:
        endpoint_result = await ctx.step.invoke(
            f"sync-{endpoint}",
            function=squarespace_sync_endpoint,  # ← Calls sub-function
            data={"source_id": source_id, "endpoint": endpoint}
        )
        results[endpoint] = endpoint_result

        # Rate limiting between endpoints
        await ctx.step.sleep(f"delay-after-{endpoint}", timedelta(seconds=2))

    # Mark as completed
    await sync_service.update_sync_status(source_id, "completed")

    return {
        "status": "completed",
        "total_items": sum(r.get("items_stored", 0) for r in results.values())
    }
```

#### Single Endpoint Sync

```python
@inngest_client.create_function(
    fn_id="squarespace_sync_endpoint",
    trigger=inngest.TriggerEvent(event="squarespace/sync.endpoint"),
    retries=3,
)
async def squarespace_sync_endpoint(ctx: inngest.Context) -> Dict[str, Any]:
    """Sync a single endpoint with pagination."""

    source_id = ctx.event.data.get("source_id")
    endpoint = ctx.event.data.get("endpoint")  # e.g., "products"

    # 1. Get source metadata
    source = await sync_service.get_external_source(source_id)

    # 2. Retrieve API key from Vault (CRITICAL: Server-side only)
    api_key = await sync_service.get_api_key(source_id)

    if not api_key:
        raise ValueError("API key not found - please configure credentials")

    # 3. Initialize adapter with decrypted API key
    adapter = SquarespaceAdapter(api_key=api_key, page_size=50)

    # 4. Stream data with pagination
    items_stored = 0
    pages_processed = 0
    batch = []

    async for record in adapter.stream_endpoint(endpoint, cursor=None):
        batch.append({
            "entity_type": record.entity_type,
            "external_id": record.external_id,
            "payload": record.payload,
            "occurred_at": record.occurred_at,
        })

        # Store in batches (25 items at a time)
        if len(batch) >= 25:
            stored = await sync_service.store_raw_events_batch(
                source_id, "squarespace", batch
            )
            items_stored += stored
            batch = []
            pages_processed += 1

            # Rate limiting: 1 second between batches
            await ctx.step.sleep(f"rate-limit-{pages_processed}", timedelta(seconds=1))

    # Store remaining items
    if batch:
        stored = await sync_service.store_raw_events_batch(source_id, "squarespace", batch)
        items_stored += stored

    return {
        "status": "completed",
        "endpoint": endpoint,
        "items_stored": items_stored,
        "pages_processed": pages_processed
    }
```

**Key Points**:

- **Automatic retries**: 3 attempts on failure
- **Rate limiting**: 1-2 second delays between requests
- **Batch processing**: Stores 25 items at a time (efficient bulk inserts)
- **Pagination**: Handles cursors for large datasets
- **Secure**: API key retrieved from Vault at runtime, never logged

---

## 4. Data Storage

All synced data is stored in the `external_raw_events` table as **raw, unprocessed JSON**.

### Database Schema

```sql
CREATE TABLE external_raw_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES external_sources(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,           -- 'squarespace', 'revolut'
  entity_type TEXT NOT NULL,        -- 'product', 'order', 'transaction'
  external_id TEXT NOT NULL,        -- ID from external system
  payload JSONB NOT NULL,           -- Raw API response (no transformation)
  occurred_at TIMESTAMPTZ,          -- Event timestamp from source
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ensure no duplicates
  UNIQUE(provider, entity_type, external_id)
);
```

**Service Method**:

```python
async def store_raw_events_batch(
    self,
    source_id: str,
    provider: str,
    events: List[Dict[str, Any]]
) -> int:
    """Store multiple raw events in a batch (upsert)."""

    if not events:
        return 0

    now = datetime.utcnow().isoformat()

    data = [
        {
            "source_id": source_id,
            "provider": provider,
            "entity_type": event["entity_type"],
            "external_id": event["external_id"],
            "payload": event["payload"],
            "occurred_at": event.get("occurred_at"),
            "fetched_at": now,
        }
        for event in events
    ]

    result = await asyncio.to_thread(
        lambda: self.client.table("external_raw_events")
        .upsert(data, on_conflict="provider,entity_type,external_id")
        .execute()
    )

    return len(result.data) if result.data else 0
```

**Key Points**:

- **Upsert strategy**: Re-syncing updates existing records instead of creating duplicates
- **No transformation**: Data is stored exactly as received from API
- **JSONB storage**: Efficient indexing and querying of JSON data
- **Bulk inserts**: 25+ items per database transaction

---

## 5. Security Architecture

### Threat Model & Mitigations

| Threat                              | Mitigation                                                             |
| ----------------------------------- | ---------------------------------------------------------------------- |
| **API keys stolen from database**   | Vault encrypts at rest; only accessible via SECURITY DEFINER functions |
| **Unauthorized access to API keys** | RLS policies filter by `entity_id` → `owner_user_id = auth.uid()`      |
| **API keys exposed in logs**        | Never logged; API key retrieval only in background jobs                |
| **Client-side access to API keys**  | Frontend never receives API keys; server-side only                     |
| **Man-in-the-middle attacks**       | HTTPS for all API communication; credentials in POST body, not URLs    |
| **Compromised background jobs**     | Inngest runs in isolated environment; API keys retrieved per-job       |

### Access Control Flow

```
User Login
    ↓
Auth (Supabase)
    ↓
RLS Policy Check: entities.owner_user_id = auth.uid()
    ↓
Application Code (FastAPI)
    ↓
SECURITY DEFINER Function (get_api_key_secure)
    ↓
Vault Decryption
    ↓
API Key Used (server-side only)
```

### Best Practices Implemented

✅ **Principle of Least Privilege**: Users can only access their own entity's API keys  
✅ **Defense in Depth**: Multiple layers (RLS, SECURITY DEFINER, Vault encryption)  
✅ **Secure by Default**: API keys never exposed to client or logs  
✅ **Audit Trail**: `api_key_last_validated_at`, `updated_at` timestamps  
✅ **Fail Secure**: Invalid keys marked as such; syncs blocked until resolved

---

## 6. Frontend User Experience

### API Key Status Indicators

The UI displays real-time status of API keys:

```typescript
<ApiKeyStatusBadge
  status={integration.api_key_status}  // 'pending', 'valid', 'invalid', 'expired'
  error={integration.api_key_error}
  lastValidated={integration.api_key_last_validated_at}
  isValidating={isValidatingApiKey}
  onValidate={() => handleValidateApiKey(integration.id)}
/>
```

**Status Badge Styles**:

- 🟡 **Pending**: Not yet validated (yellow)
- 🟢 **Valid**: Tested and working (green)
- 🔴 **Invalid**: Authentication failed (red)
- 🟠 **Expired**: Key no longer valid (orange)

### Sync Progress Feedback

Users receive real-time feedback via toast notifications:

```typescript
// Loading state
toast.loading('Syncing products...', { id: 'sync-123' });

// Success state
toast.success('Products synced successfully', { id: 'sync-123' });

// Error state
toast.error('Failed to sync products', { id: 'sync-123' });
```

**Individual Endpoint Animations**:

- Each endpoint button has independent loading state
- Only the clicked endpoint shows spinner animation
- Other endpoints remain interactive

---

## 7. Error Handling

### Common Errors & Resolutions

| Error                                     | Cause                       | Resolution                              |
| ----------------------------------------- | --------------------------- | --------------------------------------- |
| `API key not found`                       | Missing `api_key_secret_id` | Re-add integration with valid API key   |
| `Invalid API key - authentication failed` | Wrong credentials           | Update API key in settings              |
| `API key lacks required permissions`      | Insufficient scope          | Grant permissions in provider dashboard |
| `Request timed out`                       | Network/provider issues     | Retry sync later                        |
| `Sync already in progress`                | Concurrent sync attempt     | Wait for current sync to complete       |
| `Rate limit exceeded`                     | Too many requests           | Automatic backoff; retries in 60s       |

### Retry Strategy

**Inngest Functions**:

- Automatic retries: 3 attempts
- Exponential backoff: 1s, 2s, 4s
- Manual retry available in UI

**Rate Limiting**:

- 1-2 second delays between API calls
- Respects provider rate limits
- Handles 429 responses gracefully

---

## 8. Monitoring & Observability

### Key Metrics

- **API Key Validation Rate**: % of keys that pass validation
- **Sync Success Rate**: % of syncs that complete without errors
- **Items Synced Per Hour**: Data throughput
- **Average Sync Duration**: Performance tracking

### Logs

**Backend Logs** (`logger.info`):

```python
logger.info(f"Stored API key securely for source {source_id}")
logger.info(f"Completed products sync: 1,234 items, 50 pages")
logger.error(f"Failed to validate API key: {error_message}")
```

**Inngest Logs** (`ctx.logger`):

```python
ctx.logger.info(f"Starting full Squarespace sync for source {source_id}")
ctx.logger.error(f"Error syncing products: {str(e)}")
```

### Database Queries

```sql
-- Check API key status distribution
SELECT api_key_status, COUNT(*)
FROM external_sources
GROUP BY api_key_status;

-- Find sources with failed syncs
SELECT id, provider, sync_error, last_synced_at
FROM external_sources
WHERE sync_status = 'error'
ORDER BY last_synced_at DESC;

-- Monitor sync performance
SELECT
  provider,
  entity_type,
  COUNT(*) as total_records,
  MAX(fetched_at) as last_sync
FROM external_raw_events
GROUP BY provider, entity_type;
```

---

## 9. Development Workflow

### Local Setup

1. **Start Supabase**:

   ```bash
   cd infrastructure/supabase
   docker-compose up -d
   ```

2. **Run migrations**:

   ```bash
   supabase migration up
   ```

3. **Start backend**:

   ```bash
   cd apps/ai_agent
   poetry run langgraph dev  # Port 8000
   ```

4. **Start frontend**:
   ```bash
   cd apps/chat-ui
   pnpm dev  # Port 5173
   ```

### Testing API Key Flow

```bash
# 1. Create integration
curl -X POST http://localhost:8000/integrations/sources \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "123e4567-e89b-12d3-a456-426614174000",
    "provider": "squarespace",
    "external_account_id": "my-store-id",
    "api_key": "sqsp_abc123...",
    "display_name": "My Store"
  }'

# 2. Validate API key
curl -X POST http://localhost:8000/integrations/sources/{source_id}/validate

# 3. Trigger sync
curl -X POST http://localhost:8000/integrations/sources/{source_id}/sync \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "products"}'

# 4. Check sync stats
curl http://localhost:8000/integrations/sources/{source_id}/stats
```

---

## 10. Deployment Considerations

### Environment Variables

**Backend** (`.env`):

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # For Vault access
INNGEST_APP_ID=threadwise-ai-agent
INNGEST_EVENT_KEY=inngest_...
INNGEST_SIGNING_KEY=signkey_...
```

**Frontend** (`.env`):

```bash
VITE_API_URL=https://api.threadwise.com
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...  # Public key only
```

### Production Checklist

- [ ] Enable Supabase Vault encryption
- [ ] Rotate Vault encryption keys regularly
- [ ] Configure RLS policies for all tables
- [ ] Set up HTTPS with valid SSL certificates
- [ ] Enable rate limiting on API endpoints
- [ ] Configure Inngest production environment
- [ ] Set up monitoring alerts (Sentry, Datadog, etc.)
- [ ] Enable audit logging for sensitive operations
- [ ] Implement IP allowlisting for admin functions
- [ ] Regular security audits of Vault access patterns

---

## Conclusion

This end-to-end workflow provides **bank-level security** for API key management while maintaining **developer-friendly UX**. Key strengths:

✅ **Zero plaintext storage**: All API keys encrypted in Vault  
✅ **Server-side only access**: Frontend never sees credentials  
✅ **Automatic validation**: Proactive key health checks  
✅ **Reliable syncs**: Background jobs with retries and rate limiting  
✅ **Audit trail**: Full history of validation and sync events  
✅ **User transparency**: Real-time status updates and error messages

For questions or contributions, see [CONTRIBUTING.md](../CONTRIBUTING.md).
