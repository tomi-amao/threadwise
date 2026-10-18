# API Reference

The REST API is documented next to the code, with the guard each route needs:
[apps/ai_agent/docs/api.md](../apps/ai_agent/docs/api.md). How callers authenticate (a Supabase
access token, or the internal key for machine routes) is in
[apps/ai_agent/docs/security.md](../apps/ai_agent/docs/security.md).

The running server also serves an OpenAPI page at `/docs`.

The chat itself does not use the REST API: the browser talks to the LangGraph API (`/threads`,
`/runs`) on the same server, with the same token. See
[apps/ai_agent/docs/chat-agent.md](../apps/ai_agent/docs/chat-agent.md).

This page previously described routes and a WebSocket interface that no longer exist; it was
replaced rather than patched.
