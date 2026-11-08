# Orbit web app. Build from the repository root:  docker build -f apps/web/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @orbit/shared --workspace @orbit/web --include-workspace-root --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# Settings such as the API address are read at runtime (/runtime-config), not baked in here.
RUN npm run build -w @orbit/shared && npm run build -w @orbit/web

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
USER node
CMD ["sh", "-c", "cd apps/web && npx next start -p ${PORT:-3000}"]
