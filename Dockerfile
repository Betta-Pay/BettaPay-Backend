FROM node:20-alpine

WORKDIR /app

RUN corepack enable && npm install -g pnpm@10.32.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY prisma ./prisma
COPY shared ./shared
COPY services ./services

RUN pnpm install --frozen-lockfile && pnpm prisma generate
