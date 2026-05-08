# 35 — Backup & Recovery

## Overview

VoiceForge AI uses Supabase Postgres as its primary database. This document covers backup schedules, restore procedures, and testing.

## Supabase Backup Schedule

| Type | Frequency | Retention | Notes |
|------|-----------|-----------|-------|
| Auto (daily) | Daily | 7 days (free) | Supabase managed |
| Point-in-time | Continuous | 7 days (free) | Uses WAL archiving |
| Manual pg_dump | Weekly | 30 days | S3/blob storage |

## Manual Backup Procedure

### Using Supabase CLI

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Link project
supabase link --project-ref <your-project-ref>

# Create manual backup
supabase db dump --db-url <DIRECT_URL> --file backup-$(date +%Y%m%d).sql
```

### Upload to S3

```bash
# Upload to S3
aws s3 cp backup-$(date +%Y%m%d).sql s3://your-bucket/backups/
```

## Restore Procedure

### From pg_dump

```bash
# Drop and recreate database
psql $DIRECT_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Restore
psql $DIRECT_URL < backup-$(date +%Y%m%d).sql
```

### From Supabase PITR

1. Go to Supabase Dashboard → Database → Point in Time Recovery
2. Select restore point
3. Create new database branch
4. Migrate data to production

## Testing Backups

### Weekly Restore Test (Staging)

```bash
# Create staging branch from latest backup
supabase branch create restore-test-$(date +%Y%m%d) --project-ref <project-ref>

# Verify schema and data integrity
# Run: npm run db:push -- --force-reset
# Run: npm test
```

### Backup Verification Checklist

- [ ] Schema matches current migration state
- [ ] All tables have expected row counts
- [ ] Foreign keys intact
- [ ] Indexes present
- [ ] RLS policies applied

## Migration Safety

Before running migrations in production:

1. Create manual backup
2. Test on staging first
3. Use `npm run db:push` with `--force-reset` only if schema changes require it
4. Monitor for errors post-migration

## Emergency Contacts

- Supabase Support: support@supabase.io
- Database incident: P1 via Supabase dashboard