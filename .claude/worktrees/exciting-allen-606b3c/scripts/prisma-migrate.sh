#!/bin/sh
set -e
apt-get update -qq && apt-get install -y -qq openssl >/dev/null 2>&1

if [ ! -d /prisma/migrations ] || [ -z "$(ls -A /prisma/migrations)" ]; then
  echo "No migrations found. Baselining existing DB..."
  mkdir -p /prisma/migrations/0_init
  npx prisma@5.22.0 migrate diff \
    --from-empty \
    --to-schema-datamodel /prisma/schema.prisma \
    --script > /prisma/migrations/0_init/migration.sql
  npx prisma@5.22.0 migrate resolve --applied 0_init --schema=/prisma/schema.prisma
fi

npx prisma@5.22.0 migrate deploy --schema=/prisma/schema.prisma
