# 🧵 Threadwise – AI Agent-Powered Business Assistant
## 🚧 Project Roadmap

### ✅ EPIC 1: Project Initialization & Infrastructure Setup
> **Goal**: Set up the monorepo, Supabase backend, local dev environment, CI/CD, and shared tooling.

#### Tasks
- [ ] Set up the monorepo using `pnpm workspaces`
- [ ] Scaffold `apps/remix`, `apps/agent`, `packages/etl`, `packages/prisma`, and `packages/supabase`
- [ ] Initialize GitHub repo with base README and project structure
- [ ] Configure ESLint, Prettier, and TypeScript base settings
- [ ] Set up Railway or Vercel deployments for Remix app
- [ ] Bootstrap GitHub Actions or Railway plugin for scheduled jobs
- [ ] Configure environment variable schema management (e.g., `env.ts`)
- [ ] Initialize Supabase project and connect to local dev

---

### 📦 EPIC 2: Database & Business Schema Design
> **Goal**: Create a normalized schema to store financial data and agent memory.

#### Tasks
- [ ] Define Supabase schema using Prisma
- [ ] Migrate schema and seed basic test data
- [ ] Set up Supabase Auth and RLS policies
- [ ] Scaffold Prisma client with type-safe access
- [ ] Create shared Zod/Typescript types across services

---

### 🔌 EPIC 3: ETL Integration with External Services
> **Goal**: Connect to Revolut and Squarespace APIs and ingest relevant data.

#### Tasks
- [ ] Implement `etl/revolut.ts` and `etl/squarespace.ts` with OAuth/key auth
- [ ] Schedule periodic sync jobs via GitHub Actions or Railway scheduler
- [ ] Normalize and store financial transaction data into the DB
- [ ] Log ETL jobs and errors in a system table
- [ ] Create Supabase RPCs or API endpoints to trigger ETL manually

---

### 🧠 EPIC 4: LLM Agent Engine
> **Goal**: Build the LLM-powered AI agent capable of understanding and acting on business data.

#### Tasks
- [ ] Create a system prompt that defines the agent's capabilities and tone
- [ ] Use LangChain/OpenAgents to scaffold the agent’s core structure
- [ ] Connect Supabase as the memory provider (via vector + RDBMS)
- [ ] Implement tools for:
  - `get_cashflow_summary()`
  - `analyze_inventory_costs()`
  - `run_etl_job(service)`
  - `generate_report(period)`
- [ ] Implement a feedback loop to log agent queries, responses, and success status

---

### 🧩 EPIC 5: Conversational UI (Frontend)
> **Goal**: Build a modern UX that centers around interacting with the agent.

#### Tasks
- [ ] Create the Threadwise shell using Remix + Tailwind + shadcn/ui
- [ ] Implement chat UI using `react-chat-ui` or custom layout
- [ ] Connect chat to `/api/agent` endpoint for streaming LLM responses
- [ ] Add message-level feedback (👍 / 👎)
- [ ] Display Insight Cards for contextual results (e.g., graphs, tables)
- [ ] Add connection UI for linking Squarespace and Revolut accounts

---

### 🔐 EPIC 6: Auth, Onboarding & Permissions
> **Goal**: Secure the app and define onboarding flows.

#### Tasks
- [ ] Implement Supabase Auth with social logins
- [ ] Protect all data with RLS
- [ ] Onboarding steps:
  - Connect data sources
  - Explain what agent can do
  - Try your first question
- [ ] Add workspace/project support for multi-account users

---

### 📊 EPIC 7: Memory, Logs & Standard Dashboards
> **Goal**: Add persistence, agent memory, and a few reusable visual summaries.

#### Tasks
- [ ] Store chat logs and user questions
- [ ] Track memory context and history
- [ ] Design reusable Insight Cards: cashflow trend, sales by category, top SKUs
- [ ] Display agent’s past conversations and recommended actions

---

### 🧪 EPIC 8: Testing & QA
> **Goal**: Ensure stability, correctness, and accuracy.

#### Tasks
- [ ] Unit test LLM tools and ETL jobs
- [ ] Integration tests for API routes
- [ ] E2E tests with Playwright for key agent interactions
- [ ] Validate Supabase RLS policies are safe and effective

---

### 🚀 EPIC 9: Beta Launch
> **Goal**: Ship the MVP to real users.

#### Tasks
- [ ] Deploy production infrastructure
- [ ] Invite test users to try the agent
- [ ] Monitor feedback and log issues
- [ ] Optimize LLM prompts and refine tool behaviors
- [ ] Prepare analytics/reporting dashboard for internal insights

---

## 🧭 Suggested Timeline (8 Weeks MVP)

| Week | Focus                        |
|------|------------------------------|
| 1    | Setup + Schema + Supabase    |
| 2    | ETL integration              |
| 3    | LLM Agent core               |
| 4    | Tooling + Agent Memory       |
| 5    | Chat UI + Insight Cards      |
| 6    | Auth + Onboarding + RLS      |
| 7    | Testing + QA                 |
| 8    | Launch + Feedback Loop       |