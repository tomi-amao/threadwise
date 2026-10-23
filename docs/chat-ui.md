# Chat UI

This page used to describe the first chat page (`ChatProvider`, `ChatLayout`, `components/thread/*`,
`components/visualizations/*`). That code was removed in October 2026 when the assistant became a
right-hand panel on every page. The frontend is documented here instead:

| You want                                                    | Read                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| How the frontend is built, its data paths, routes, tests    | [`CLAUDE.md`](../CLAUDE.md) (repo root)                                    |
| The design rules every page follows, the panel's included   | [design-language.md](./design-language.md), "As built"                     |
| The assistant: panel, provider, cards, follow-ups, contract | [chat-redesign-plan.md](./chat-redesign-plan.md), sections 3, 4, 11 and 12 |
| The agent behind it                                         | [apps/ai_agent/docs/chat-agent.md](../apps/ai_agent/docs/chat-agent.md)    |
| The end-to-end tests                                        | [apps/chat-ui/e2e/README.md](../apps/chat-ui/e2e/README.md)                |

In short: `app/providers/AssistantProvider.tsx` (mounted once in `AppLayout`) wraps the LangGraph
SDK's `useStream`; `app/components/assistant/` holds the panel, the conversation, the thread list
and the generative UI cards; `/chat` shows the same conversation full width.
