FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json eslint.config.js vitest.config.ts .prettierrc ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io osmium-tool sqlite3 spatialite-bin unzip \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY scripts ./scripts
COPY docker ./docker
COPY docker-compose.yml ./docker-compose.yml
COPY package.json ./
EXPOSE 3000
CMD ["sh", "-c", "npm run migrate && node dist/src/server.js"]
