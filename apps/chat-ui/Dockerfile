# syntax=docker/dockerfile:1
#
# ThreadWise chat UI (React Router 7, server-rendered).
#
# Build from the repository root, because the pnpm workspace and lockfile live there:
#   docker build -f apps/chat-ui/Dockerfile -t threadwise-chat-ui .
#
# Only VITE_* values are baked into the browser bundle (build args below): the browser's
# Supabase client reads VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY, nothing else.
# Everything else (the server's Supabase keys, AI_AGENT_URL, ...) is read at runtime, so
# pass it with `docker run -e` / `--env-file` and never copy a .env file into the image.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The version is pinned by "packageManager" in the root package.json.
RUN corepack enable
WORKDIR /app

# Workspace manifests only, so dependency layers are cached until they change.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/chat-ui/package.json apps/chat-ui/package.json

# Lifecycle scripts are skipped because the root "prepare" script runs husky (a dev tool
# that is not installed here). The packages that do need a build step are rebuilt below.
FROM manifests AS build-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter threadwise-chat-ui... \
    && pnpm rebuild esbuild @tailwindcss/oxide

FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter threadwise-chat-ui...

FROM build-deps AS build
ARG VITE_LANGGRAPH_API_URL
ARG VITE_LANGGRAPH_ASSISTANT_ID
ARG VITE_AI_AGENT_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_LANGGRAPH_API_URL=$VITE_LANGGRAPH_API_URL \
    VITE_LANGGRAPH_ASSISTANT_ID=$VITE_LANGGRAPH_ASSISTANT_ID \
    VITE_AI_AGENT_URL=$VITE_AI_AGENT_URL \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
COPY apps/chat-ui apps/chat-ui
RUN pnpm --filter threadwise-chat-ui build

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app/apps/chat-ui
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/chat-ui/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/chat-ui/build ./build
COPY --chown=node:node apps/chat-ui/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]
