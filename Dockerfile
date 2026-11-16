# syntax=docker/dockerfile:1

FROM oven/bun:1.4.4-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock prisma7.config.ts ./
COPY patches ./patches
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM base AS prod-deps
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/src/generated ./src/generated
COPY package.json bun.lock next.config.ts tsconfig.json prisma7.config.ts ./
COPY patches ./patches
COPY prisma ./prisma
COPY public ./public
COPY scripts ./scripts
COPY src ./src

ARG NEXT_PUBLIC_GA_ID=""
ENV NEXT_PUBLIC_GA_ID=${NEXT_PUBLIC_GA_ID}
ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run build && rm -rf /app/.next/cache

FROM base AS runner
LABEL org.opencontainers.image.title="GetCodex Plus" \
    org.opencontainers.image.description="ChatGPT recharge and upgrade portal with background worker and PostgreSQL persistence"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --chown=bun:bun package.json bun.lock next.config.ts prisma7.config.ts ./
COPY --chown=bun:bun prisma ./prisma
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun --from=prod-deps /app/node_modules ./node_modules
COPY --chown=bun:bun --from=builder /app/.next ./.next
COPY --chown=bun:bun --from=builder /app/src ./src

RUN chmod +x /app/scripts/docker-entrypoint.sh \
    && mkdir -p /app/.data \
    && chmod 700 /app/.data \
    && chown bun:bun /app /app/.data

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/app/scripts/docker-entrypoint.sh", "healthcheck"]

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["web"]
