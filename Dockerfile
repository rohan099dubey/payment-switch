# One image definition for every service; pick it with --build-arg SERVICE=<dir name>.
# Node 22 rather than the spec's 20, which is EOL (ADR-009). Otherwise verbatim from
# ARCHITECTURE.md section 15.
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npx buf generate && npx tsc -b

FROM node:22-alpine AS runtime
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN npm prune --omit=dev
USER node
CMD ["sh", "-c", "node services/${SERVICE}/dist/main.js"]
