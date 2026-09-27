FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY prisma ./prisma
COPY shared ./shared
COPY services ./services

RUN pnpm install --frozen-lockfile && pnpm prisma generate
