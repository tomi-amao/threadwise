# Inngest Integration for ThreadWise AI Agent

This directory contains the Inngest integration for background processing and workflow automation in the ThreadWise AI Agent.

## Overview

The integration provides:

- **Background processing** for chat messages and document embeddings
- **Scheduled tasks** for cleanup and maintenance
- **Event-driven workflows** for analytics and notifications
- **Proper error handling** and retries

## File Structure

```
ai_agent/
├── inngest_config.py     # Inngest client configuration
├── inngest_functions.py  # Background function definitions
├── inngest_events.py     # Event helpers for triggering functions
└── main.py              # FastAPI integration
```

## Configuration

Set these environment variables:

```bash
# Required
INNGEST_APP_ID="threadwise-ai-agent"

# Optional (for production)
INNGEST_EVENT_KEY="your-event-key"
INNGEST_SIGNING_KEY="your-signing-key"
```

## Functions

### 1. Chat Message Processing (`process_chat_message`)

- **Trigger**: `chat/message.received`
- **Purpose**: Analytics, entity extraction, engagement metrics
- **Automatically triggered**: When chat messages are sent

### 2. Document Embedding Processing (`process_document_embedding`)

- **Trigger**: `documents/embedding.completed`
- **Purpose**: Document indexing, categorization, notifications
- **Automatically triggered**: When document embeddings complete

### 3. Cleanup (`cleanup_old_threads`)

- **Trigger**: Daily cron job (2 AM UTC)
- **Purpose**: Archive old threads, cleanup temp files
- **Can be manually triggered**: `POST /inngest/trigger-cleanup`

## API Endpoints

### Health Check

```
GET /inngest/health
```

Returns Inngest service status and configuration.

### Manual Cleanup Trigger

```
POST /inngest/trigger-cleanup
```

Manually trigger the cleanup function for testing.

## Development

### Local Setup

1. Start the Inngest dev server:

   ```bash
   npx inngest-cli@latest dev
   ```

2. Start your FastAPI app:

   ```bash
   pnpm dev:ai-agent
   ```

3. Visit the Inngest dashboard at http://localhost:8288

### Testing Functions

The functions will automatically register with the Inngest dev server. You can:

- View function definitions in the dashboard
- Manually trigger functions with test events
- Monitor execution logs and errors

### Adding New Functions

1. Add your function to `inngest_functions.py`
2. Add it to the `FUNCTIONS` export list
3. Create event helpers in `inngest_events.py` if needed
4. The function will auto-register when the app starts

## Production Deployment

1. Set environment variables for event and signing keys
2. Configure Inngest Cloud or self-hosted instance
3. Monitor function execution through Inngest dashboard
4. Set up alerting for failed functions

## Error Handling

- All functions include comprehensive error handling
- Failed functions will retry automatically (Inngest default)
- Errors are logged with context for debugging
- Non-critical failures won't affect API responses

## Security

- Signing key validation in production
- No sensitive data in event payloads
- Namespace isolation for multi-tenant data
- Secure integration with existing auth systems
