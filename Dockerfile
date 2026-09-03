FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc* ./
# vendor/ holds local tarball dependencies (file:vendor/*.tgz in package.json,
# for packages not yet published to npm) — pnpm needs them on disk to resolve
# the lockfile, so they have to land before install, not with the rest of the
# source in the next COPY.
COPY vendor/ ./vendor/
RUN pnpm install --frozen-lockfile --shamefully-hoist
COPY . .
RUN pnpm run build

FROM node:22-alpine
RUN apk add --no-cache openssh-client
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src ./src
EXPOSE 3000
CMD ["node", "dist/main"]
