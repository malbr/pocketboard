# syntax=docker/dockerfile:1
# Build context: repository root. Base images are pinned by digest so the same
# commit always builds from the same inputs.

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace=packages/api --include-workspace-root=false --ignore-scripts
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npm run build --workspace=packages/api

# Runtime dependencies only: no bundler, test runner, or TypeScript tooling.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
# The shared contracts are inlined by the bundle, so the workspace link goes.
# npm nests a dependency under packages/api when its version conflicts with a
# hoisted copy (drizzle-orm today); that directory ships too, so it must exist.
RUN npm ci --workspace=packages/api --include-workspace-root=false --omit=dev --ignore-scripts \
  && rm -rf node_modules/@pocketboard \
  && mkdir -p packages/api/node_modules

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/malbr/pocketboard" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.title="pocketboard-api"
# The runtime never installs packages, so the package managers are removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production
# The root manifest marks the repository root that the API resolves relative
# paths against; it carries no dependencies of its own at runtime.
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/api/node_modules packages/api/node_modules
COPY packages/api/package.json packages/api/
COPY packages/api/migrations packages/api/migrations
COPY --from=build /app/packages/api/dist packages/api/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1
CMD ["node", "packages/api/dist/server.js"]
