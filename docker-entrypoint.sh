#!/bin/sh
set -eu

pnpm install --frozen-lockfile
pnpm prisma generate
pnpm prisma migrate deploy
exec "$@"
