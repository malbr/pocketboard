# syntax=docker/dockerfile:1
# Build context: repository root. Base images are pinned by digest so the same
# commit always builds from the same inputs.

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace=packages/web --include-workspace-root=false --ignore-scripts
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN npm run build --workspace=packages/web

FROM nginxinc/nginx-unprivileged:1.31.6-alpine-slim@sha256:dcc9bf9c084901dddbbce305130a7295c5637b6a8fce3e29cf678d86336982e4
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/malbr/pocketboard" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.title="pocketboard-web"
COPY packages/web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY packages/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
