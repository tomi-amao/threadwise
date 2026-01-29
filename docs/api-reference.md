# API Reference

## Overview

ThreadWise exposes two API surfaces:

1. **LangGraph Server API** - For chat/agent interactions
2. **FastAPI REST API** - For embeddings and file processing

## LangGraph Server API

Base URL: `http://localhost:2024`

### Threads

#### Create Thread

```http
POST /threads
Content-Type: application/json

{
  "metadata": {
    "title": "Financial Analysis"
  }
}
```

**Response:**

```json
{
  "thread_id": "uuid-string",
  "created_at": "2024-01-27T00:00:00Z",
  "metadata": {
    "title": "Financial Analysis"
  }
}
```

#### List Threads

```http
GET /threads?limit=100
```

**Response:**

```json
[
  {
    "thread_id": "uuid-string",
    "created_at": "2024-01-27T00:00:00Z",
    "metadata": {},
    "status": "idle"
  }
]
```

#### Get Thread

```http
GET /threads/{thread_id}
```

#### Update Thread

```http
PATCH /threads/{thread_id}
Content-Type: application/json

{
  "metadata": {
    "title": "Updated Title"
  }
}
```

#### Delete Thread

```http
DELETE /threads/{thread_id}
```

### Runs (Message Execution)

#### Create Run

Send a message to the AI agent:

```http
POST /threads/{thread_id}/runs
Content-Type: application/json

{
  "assistant_id": "threadwise-financial-agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "What were our top 10 customers last quarter?"
      }
    ]
  }
}
```

**Response (Streaming):**

```
data: {"type": "message", "content": "Let me analyze..."}
data: {"type": "tool_call", "name": "sql_db_query", ...}
data: {"type": "message", "content": "Based on the data..."}
data: {"type": "ui", "component": "bar-chart", "props": {...}}
data: [DONE]
```

#### Create Run with File Attachment

```http
POST /threads/{thread_id}/runs
Content-Type: application/json

{
  "assistant_id": "threadwise-financial-agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "Process this invoice"},
          {
            "type": "file",
            "source_type": "base64",
            "data": "JVBERi0xLjQ...",
            "mime_type": "application/pdf"
          }
        ]
      }
    ]
  }
}
```

#### Get Run State

```http
GET /threads/{thread_id}/runs/{run_id}
```

#### Cancel Run

```http
POST /threads/{thread_id}/runs/{run_id}/cancel
```

### State

#### Get Thread State

```http
GET /threads/{thread_id}/state
```

**Response:**

```json
{
  "values": {
    "messages": [...],
    "query_type": "analytics",
    "retrieved_context": [...]
  },
  "metadata": {}
}
```

#### Update Thread State

```http
POST /threads/{thread_id}/state
Content-Type: application/json

{
  "values": {
    "model": "gemini"
  }
}
```

### History

#### Get Thread History

```http
GET /threads/{thread_id}/history
```

**Response:**

```json
{
  "messages": [
    {
      "id": "msg-123",
      "type": "human",
      "content": "Show top customers"
    },
    {
      "id": "msg-124",
      "type": "ai",
      "content": "Based on the analysis..."
    }
  ]
}
```

## FastAPI REST API

Base URL: `http://localhost:8000`

### Health Check

```http
GET /
```

**Response:**

```json
{
  "message": "Welcome to ThreadWise AI Agent API",
  "version": "0.1.0",
  "status": "healthy"
}
```

### Embeddings

#### Embed File from URL

```http
POST /embed/file
Content-Type: application/json

{
  "file_type": "pdf",
  "file_url": "https://storage.example.com/document.pdf"
}
```

**Response:**

```json
{
  "success": true,
  "documentId": "doc-uuid",
  "chunks": 15,
  "filename": "document.pdf"
}
```

#### Search Documents

```http
POST /search
Content-Type: application/json

{
  "query": "revenue recognition policies",
  "limit": 5
}
```

**Response:**

```json
{
  "results": [
    {
      "content": "Revenue is recognized when...",
      "metadata": {
        "source": "accounting-policies.pdf",
        "page": 3
      },
      "similarity": 0.89
    }
  ]
}
```

### Chat (Legacy)

#### Send Message

```http
POST /chat
Content-Type: application/json

{
  "content": "What is a balance sheet?",
  "thread_id": "optional-thread-id"
}
```

**Response:**

```json
{
  "content": "A balance sheet is a financial statement...",
  "thread_id": "thread-uuid",
  "assistant_id": "threadwise-financial-agent",
  "timestamp": "2024-01-27T00:00:00Z",
  "status": "completed"
}
```

## Generative UI Events

The agent streams UI component events for rich visualizations:

### Bar Chart

```json
{
  "type": "ui",
  "component": "bar-chart",
  "props": {
    "title": "Revenue by Quarter",
    "data": [
      { "label": "Q1", "value": 125000 },
      { "label": "Q2", "value": 148000 },
      { "label": "Q3", "value": 162000 }
    ],
    "format": "currency"
  }
}
```

### Pie Chart

```json
{
  "type": "ui",
  "component": "pie-chart",
  "props": {
    "title": "Expense Distribution",
    "data": [
      { "label": "Salaries", "value": 45 },
      { "label": "Marketing", "value": 25 },
      { "label": "Operations", "value": 30 }
    ],
    "format": "percentage"
  }
}
```

### Metric Card

```json
{
  "type": "ui",
  "component": "metric-card",
  "props": {
    "title": "Total Revenue",
    "value": 1250000,
    "format": "currency",
    "trend": {
      "direction": "up",
      "percentage": 12.5
    }
  }
}
```

### Financial Table

```json
{
  "type": "ui",
  "component": "financial-table",
  "props": {
    "title": "Top Customers",
    "data": [
      { "Customer": "Acme Corp", "Revenue": 50000, "Orders": 12 },
      { "Customer": "Globex Inc", "Revenue": 45000, "Orders": 8 }
    ],
    "format": "currency"
  }
}
```

## Error Responses

All endpoints return standard error responses:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": {
      "field": "content",
      "issue": "Required field missing"
    }
  }
}
```

### Error Codes

| Code               | HTTP Status | Description          |
| ------------------ | ----------- | -------------------- |
| `VALIDATION_ERROR` | 400         | Invalid request body |
| `NOT_FOUND`        | 404         | Resource not found   |
| `RATE_LIMITED`     | 429         | Too many requests    |
| `INTERNAL_ERROR`   | 500         | Server error         |
| `LLM_ERROR`        | 502         | LLM provider error   |
| `DB_ERROR`         | 503         | Database unavailable |

## Rate Limits

Default rate limits (configurable):

| Endpoint   | Limit      |
| ---------- | ---------- |
| `/threads` | 100/minute |
| `/runs`    | 20/minute  |
| `/embed`   | 10/minute  |
| `/search`  | 50/minute  |

## WebSocket Streaming

For real-time streaming, connect via WebSocket:

```javascript
const ws = new WebSocket('ws://localhost:2024/ws');

ws.send(
  JSON.stringify({
    type: 'run',
    thread_id: 'uuid',
    input: {
      messages: [{ role: 'user', content: 'Hello' }],
    },
  })
);

ws.onmessage = event => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

## SDK Usage

### JavaScript/TypeScript

```typescript
import { Client } from '@langchain/langgraph-sdk';

const client = new Client({
  apiUrl: 'http://localhost:2024',
});

// Create thread
const thread = await client.threads.create({ metadata: { title: 'Analysis' } });

// Run agent
const run = await client.runs.create(thread.thread_id, {
  assistantId: 'threadwise-financial-agent',
  input: {
    messages: [{ role: 'user', content: 'Show revenue trends' }],
  },
});

// Stream responses
for await (const event of run) {
  console.log(event);
}
```

### Python

```python
from langgraph_sdk import get_client

client = get_client(url="http://localhost:2024")

# Create thread
thread = await client.threads.create(metadata={"title": "Analysis"})

# Run agent
async for event in client.runs.stream(
    thread["thread_id"],
    "threadwise-financial-agent",
    input={"messages": [{"role": "user", "content": "Show revenue"}]}
):
    print(event)
```

## Authentication

Currently, the development server runs without authentication. For production:

### API Key Authentication

```http
Authorization: Bearer your-api-key
```

### Supabase JWT

```http
Authorization: Bearer supabase-jwt-token
```

Configure in environment:

```bash
AUTH_ENABLED=true
AUTH_PROVIDER=supabase
SUPABASE_JWT_SECRET=your-jwt-secret
```
