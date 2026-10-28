# Deploying the backend to Render

The AI agent runs on [Render](https://render.com) as the LangGraph server (which mounts the
FastAPI app), with its own Postgres and Redis. The frontend stays on Vercel, business data stays
in Supabase, and background jobs run on Inngest Cloud. Everything is declared in
[`render.yaml`](../../../render.yaml) at the repo root, and a push to `main` redeploys it.

```
browser ──> Vercel (chat-ui, fra1) ──> Render: threadwise-ai-agent (frankfurt) ──> Supabase (eu-central-1)
                                          │  ├─ Render Postgres  (LangGraph threads, runs, checkpoints)
                                          │  └─ Render Key Value (streaming pub/sub, run queue)
                     Inngest Cloud <──────┘  /api/inngest (provider syncs, normalisation)
```

## What it costs to run

Nothing: `render.yaml` uses Render's free plans for all three, so no payment method is needed.
That suits testing, with these costs instead (Render's free plan page has the details):

- **The web service sleeps** after 15 minutes without traffic and takes about a minute to wake,
  on top of the app's own ~7 s start-up. The first assistant question after a quiet spell is
  slow and may time out in the browser; ask again once it is up. The workspace gets 750 free
  instance hours a month (a sleeping service uses none), and builds count against the free
  build minutes.
- **The Postgres expires 30 days after creation.** After a 14-day grace period Render deletes
  it, and every chat thread with it. To keep going, upgrade it, or delete it and sync the
  Blueprint again to get a new one (the service picks up the new `DATABASE_URI` from
  `fromDatabase`). One free Postgres per workspace; 1 GB; no backups.
- **The Key Value keeps nothing across a restart**, so runs in flight at that moment are lost.
  One free Key Value per workspace.

For always-on, change the `plan:` lines in `render.yaml`: `0.5c-512mb` for the web service (the
server idles at about 240 MB) and `0.1c-256mb` for Postgres. Paid plans need a payment method on
the Render workspace; check Render's pricing page for the figures.

## One-time setup

### 1. Inngest Cloud

1. Create an Inngest account and use the **Production** environment.
2. Copy the **Event key** and the **Signing key** (Manage → Event keys / Signing key). These go
   to Render in step 2.
3. Create an **API key** (Settings → API keys). This goes to GitHub in step 4.

### 2. Render

1. In Render: **New → Blueprint**, connect the GitHub repo and pick `main`. Render reads
   `render.yaml` and shows the service, the database and the Key Value it will create.
2. It asks for every variable marked `sync: false`. Fill them in:

   | Variable               | Value                                                                                                                                                   |
   | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `LANGSMITH_API_KEY`    | A LangSmith API key. For an EU LangSmith organisation also add `LANGSMITH_ENDPOINT` = `https://eu.api.smith.langchain.com`                              |
   | `SUPABASE_URL`         | `https://<project-ref>.supabase.co`                                                                                                                     |
   | `SUPABASE_KEY`         | Supabase **secret** key (`sb_secret_…`), Settings → API Keys                                                                                            |
   | `DATABASE_URL`         | Supabase Postgres connection string (the pooler, role `postgres`: it must be able to `SET ROLE authenticated`)                                          |
   | `GOOGLE_API_KEY`       | The Gemini key                                                                                                                                          |
   | `CORS_ALLOW_ORIGINS`   | The frontend origin(s), comma-separated, exact (see "The Vercel side")                                                                                  |
   | `FRONTEND_URL`         | The frontend origin, e.g. `https://threadwise-the-ignorant-view.vercel.app`                                                                             |
   | `INNGEST_SIGNING_KEY`  | From step 1                                                                                                                                             |
   | `INNGEST_EVENT_KEY`    | From step 1                                                                                                                                             |
   | `INNGEST_SERVE_ORIGIN` | This service's URL, `https://threadwise-ai-agent.onrender.com` (Render adds a suffix if the name is taken: check the URL after creation and correct it) |
   | `ZOHO_*`               | Only if Zoho Calendar is used. `ZOHO_REDIRECT_URI` is the service URL + `/oauth/zoho_calendar/callback`, also registered in Zoho's API Console          |

   `INTERNAL_API_KEY` and `TRACE_HASH_SALT` are generated for you. Do **not** set
   `INNGEST_DEV`: with it, `/api/inngest` accepts unsigned requests.

3. Apply. The first build takes a few minutes. When it is live:

   ```bash
   curl https://threadwise-ai-agent.onrender.com/ok        # {"ok":true,...}
   curl https://threadwise-ai-agent.onrender.com/health    # "commit" is the deployed commit
   curl -X POST https://threadwise-ai-agent.onrender.com/threads/search -d '{}' \
     -H 'content-type: application/json' -o /dev/null -w '%{http_code}\n'   # 401: auth is on
   ```

### 3. First Inngest sync

In the Inngest dashboard: **Apps → Sync new app**, URL
`https://threadwise-ai-agent.onrender.com/api/inngest`. The app appears as `threadwise-ai-agent`
with its functions.

### 4. GitHub (keeps Inngest in sync after each deploy)

In the repo's **Settings → Secrets and variables → Actions**:

- variable `AI_AGENT_URL` = `https://threadwise-ai-agent.onrender.com`
- secret `INNGEST_API_KEY` = the API key from step 1
- (optional) variable `INNGEST_APP_ID`, only if the app is not called `threadwise-ai-agent`

Until both are set, the **Inngest Sync** workflow skips itself.

### 5. The Vercel side

In the Vercel project's environment variables:

| Variable                 | Value                                      | When it applies                                               |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------- |
| `VITE_LANGGRAPH_API_URL` | `https://threadwise-ai-agent.onrender.com` | Build time: redeploy after changing it                        |
| `VITE_AI_AGENT_URL`      | `https://threadwise-ai-agent.onrender.com` | Build time: redeploy after changing it                        |
| `AI_AGENT_URL`           | `https://threadwise-ai-agent.onrender.com` | Runtime (server loaders)                                      |
| `ASSISTANT_ENABLED`      | `true`                                     | Runtime. The assistant is off in production until this is set |

`CORS_ALLOW_ORIGINS` on Render must contain the exact origin the browser loads the app from.
Vercel gives every deployment its own URL, so list the stable ones: the production domain and/or
the branch alias (e.g. `https://threadwise-git-<branch>-the-ignorant-view.vercel.app`). A
one-off deployment URL is refused by CORS unless it is added.

## Day to day

- **Push to `main`.** Checks run; when **all** of them pass (CI, the security scans, the Docker
  build), Render builds and deploys the backend (only when something under `apps/ai_agent/`
  changed: `buildFilter`). A single failing check means no deploy, with nothing in Render's
  event log to say so: fix the check, or use **Manual Deploy** in Render's dashboard.
- **After a deploy.** Render reports it to GitHub as a deployment, and that starts the **Inngest
  Sync** workflow, which checks `/health` is serving the new backend (waking the free instance)
  and re-syncs the functions with Inngest. It must not start from CI: its own run is a check on
  the commit, so Render would wait for it while it waited for Render. A failed deploy shows in
  Render's dashboard, leaves the previous version serving, and starts no sync.
- **Changing `langgraph.json`.** The `Dockerfile` is generated from it, and Render builds the
  `Dockerfile`, so regenerate it in the same commit:
  `cd apps/ai_agent && poetry run langgraph dockerfile Dockerfile`.
- **Changing a secret.** In Render's dashboard (Environment); saving it redeploys. Variables
  marked `sync: false` are only asked for when the Blueprint is first created, so a **new**
  variable needs both a line in `render.yaml` and a value in the dashboard.
- **Changing infrastructure** (plan, region of a new service, a new database). Edit
  `render.yaml` and push; Render applies Blueprint changes on sync. The region of an existing
  service or database cannot be changed.
- **Logs.** Render dashboard → the service → Logs. LangSmith receives traces when tracing is
  enabled (`docs/operations.md`).

## Limits worth knowing

- The embedding routes load a sentence-transformers model (about 1 GB), which no instance below
  `1c-2g` can hold; the chat agent and the pipeline fit in the free instance.
- The run limiter in `auth.py` is per process, which is fine while there is one instance (free
  services cannot scale beyond one).
- Render may restart free services at any time; a restart loses the Key Value's contents.
