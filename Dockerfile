# syntax=docker/dockerfile:1
# One image recipe for all six services: docker build --build-arg SERVICE=ledger .
ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Manifests first so `npm ci` stays cached until a dependency changes.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/common/package.json packages/common/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/auth-kyc/package.json services/auth-kyc/
COPY services/ledger/package.json services/ledger/
COPY services/transfer/package.json services/transfer/
COPY services/bank-rail/package.json services/bank-rail/
COPY services/worker/package.json services/worker/
RUN npm ci
COPY packages packages
COPY services services
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production \
    SERVICE=${SERVICE}
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/common/package.json packages/common/package.json
COPY --from=build /app/packages/common/dist packages/common/dist
COPY --from=build /app/services/${SERVICE}/package.json services/${SERVICE}/package.json
COPY --from=build /app/services/${SERVICE}/dist services/${SERVICE}/dist
USER node
# dd-trace loads first so it can patch http, pg, ioredis, fastify and pino; DD_* env configures it.
CMD ["sh", "-c", "exec node -r dd-trace/init services/${SERVICE}/dist/index.js"]
