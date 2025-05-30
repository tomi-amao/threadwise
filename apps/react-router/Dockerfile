# Multi-stage build for React Router with pnpm
FROM node:20-alpine AS base
# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Development dependencies stage
FROM base AS development-dependencies-env
WORKDIR /app
# Copy workspace configuration files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Copy only the React Router package.json for this specific app
COPY apps/react-router/package.json ./apps/react-router/
# Install dependencies for the React Router workspace
RUN pnpm install --frozen-lockfile --filter threadwise-react-router...

# Production dependencies stage
FROM base AS production-dependencies-env
WORKDIR /app
# Copy workspace configuration files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/react-router/package.json ./apps/react-router/
# Install only production dependencies for React Router, skip scripts to avoid husky errors
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter threadwise-react-router

# Build stage
FROM base AS build-env
WORKDIR /app
# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/react-router ./apps/react-router/
# Copy node_modules from development stage
COPY --from=development-dependencies-env /app/node_modules ./node_modules
COPY --from=development-dependencies-env /app/apps/react-router/node_modules ./apps/react-router/node_modules
# Build the React Router app
WORKDIR /app/apps/react-router
RUN pnpm build

# Production stage
FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
# Copy workspace configuration
COPY package.json pnpm-workspace.yaml ./
COPY apps/react-router/package.json ./apps/react-router/
# Copy production dependencies
COPY --from=production-dependencies-env /app/node_modules ./node_modules
COPY --from=production-dependencies-env /app/apps/react-router/node_modules ./apps/react-router/node_modules
# Copy built application
COPY --from=build-env /app/apps/react-router/build ./apps/react-router/build

WORKDIR /app/apps/react-router
EXPOSE 3000
CMD ["pnpm", "start"]