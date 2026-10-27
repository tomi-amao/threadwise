# ai_agent documentation

The backend of ThreadWise: a Python service that answers questions about a business's data in
chat, pulls that data in from Shopify, Revolut, PayPal, Squarespace and Zoho Calendar, and keeps a
double-entry ledger from it.

These pages are for developers working on this service. Start with
[architecture.md](architecture.md), then read the page for the part you are changing.

| Page                                 | What it covers                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)   | How the service is laid out: the processes, the three subsystems, the two database paths. |
| [security.md](security.md)           | Who a request is for, how that is checked, and how the agent's database access is scoped. |
| [chat-agent.md](chat-agent.md)       | The chat agent: its tools, middleware, models, and how to add a tool.                     |
| [data-pipeline.md](data-pipeline.md) | Provider sync and normalisation through Inngest, and how to add a provider.               |
| [accounting.md](accounting.md)       | Journals, account mapping, invoices and their lifecycle.                                  |
| [api.md](api.md)                     | Every REST route, grouped by router, with the guard each one needs.                       |
| [evals.md](evals.md)                 | The golden set, the oracle, thresholds, the nightly real-model run and the review queue.  |
| [operations.md](operations.md)       | The rollout flag, settings, limits and cost, logs and tracing, retention and privacy.     |
| [development.md](development.md)     | Setup, running locally, configuration, tests, lint and CI.                                |
| [deploy-render.md](deploy-render.md) | Deploying to Render from `render.yaml`, Inngest Cloud, and the Vercel side.               |

Related documents elsewhere in the repo:

- [`../CLAUDE.md`](../CLAUDE.md): the condensed rules for this service (also read by coding
  agents). When a rule there and a page here disagree, the code decides; fix whichever is wrong.
- [`../../../docs/chat-redesign-plan.md`](../../../docs/chat-redesign-plan.md): the plan the chat
  agent is being rebuilt to, with the results of each phase so far.
- [`../../../CLAUDE.md`](../../../CLAUDE.md): the whole monorepo, including the frontend and how
  it calls this service.

`../../../docs/ai-agent.md` and `../../../docs/api-reference.md` describe the chat graph that was
removed in October 2026. They are out of date; use these pages instead.
