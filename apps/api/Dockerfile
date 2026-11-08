# Orbit API. Build from the repository root:  docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @orbit/shared --workspace @orbit/api --include-workspace-root --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @orbit/shared && npm run build -w @orbit/api

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Render (and most hosts) set PORT; the API listens on it.
EXPOSE 4000
USER node
# Applies migrations (and the demo data if SEED_DEMO=true), then starts the API.
CMD ["node", "apps/api/dist/scripts/start.js"]
