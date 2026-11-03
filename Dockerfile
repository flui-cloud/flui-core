FROM kopia/kopia:0.23.1@sha256:89fd95ee2942880ca00eae964266958a394421ddbdf69bca62e38afc55f5900e AS kopia

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile --shamefully-hoist
COPY . .
RUN pnpm run build

FROM node:22-alpine
LABEL org.opencontainers.image.title="Flui API" \
      org.opencontainers.image.description="Flui API: open source PaaS for European cloud providers and your own servers." \
      org.opencontainers.image.source="https://github.com/flui-cloud/flui-core" \
      org.opencontainers.image.url="https://flui.cloud" \
      org.opencontainers.image.documentation="https://docs.flui.cloud" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
RUN apk add --no-cache openssh-client
COPY --from=kopia /bin/kopia /usr/local/bin/kopia
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src ./src
EXPOSE 3000
CMD ["node", "dist/main"]
