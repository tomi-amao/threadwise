# AI Agent

This page used to describe the chat graph (`graph_agent.py`: classify, retrieve, route, then a
second model call to guess a chart). That graph was replaced in October 2026 by a single
tool-calling agent, and the documentation moved next to the code so it stays current:

| You want                                  | Read                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| How the service is laid out               | [apps/ai_agent/docs/architecture.md](../apps/ai_agent/docs/architecture.md)   |
| The chat agent: tools, middleware, models | [apps/ai_agent/docs/chat-agent.md](../apps/ai_agent/docs/chat-agent.md)       |
| How a request is authenticated and scoped | [apps/ai_agent/docs/security.md](../apps/ai_agent/docs/security.md)           |
| Provider sync and normalisation           | [apps/ai_agent/docs/data-pipeline.md](../apps/ai_agent/docs/data-pipeline.md) |
| Journals, accounts and invoices           | [apps/ai_agent/docs/accounting.md](../apps/ai_agent/docs/accounting.md)       |
| Running, configuring and testing it       | [apps/ai_agent/docs/development.md](../apps/ai_agent/docs/development.md)     |

The full index is [apps/ai_agent/docs/README.md](../apps/ai_agent/docs/README.md). Where the chat
is going next (a right-hand panel, generated charts, follow-up questions) is in
[chat-redesign-plan.md](./chat-redesign-plan.md).
