# 35 — Backup & Recovery

## Overview

VoiceForge AI uses Supabase Postgres as its primary database. This document covers backup schedules, restore procedures, and testing.

## Backup Scope and Schedule

Supabase Postgres is external to the EC2 Compose stack. Backup availability,
retention, PITR support, and any database-branch feature depend on the active
Supabase project plan; verify them in Supabase Dashboard → Database → Backups
rather than assuming a fixed free-plan schedule.

Uploaded knowledge files are a separate backup domain. Production uses S3 when
`KNOWLEDGE_STORAGE_PROVIDER=s3`, in the bucket named by `S3_KNOWLEDGE_BUCKET`.
A database restore does not restore those objects. Verify bucket versioning and
lifecycle/replication settings in AWS as part of every recovery review.

Any manual logical-backup schedule and retention policy must name an owner,
encrypted destination, retention period, and restore-test cadence. None is
created by `deploy-aws-ec2.yml` or `infra/aws/provision.sh`.

## Logical Backup Procedure

Run from a secured operator workstation with PostgreSQL client tools installed.
Use the direct database connection, not the PgBouncer runtime URL. Do not put the
URL on the command line; `PG*` environment variables or a protected password file
avoid leaking credentials through process listings and shell history.

```bash
# Example: write a custom-format artifact suitable for pg_restore.
# Configure PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD securely first.
pg_dump --format=custom --no-owner --no-privileges --file "voiceforge-$(date +%Y%m%d).dump"

# Upload to the approved encrypted backup prefix; do not use the knowledge bucket
# unless its policy explicitly covers database backups.
aws s3 cp "voiceforge-$(date +%Y%m%d).dump" "s3://<backup-bucket>/database/"
```

## Restore Drill (isolated target only)

Never run the drill against production and never start by dropping the production
`public` schema. Provision an empty, isolated PostgreSQL target compatible with
production extensions, then restore the artifact:

```bash
# Configure PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD for the isolated target.
pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges \
  --dbname "$PGDATABASE" "voiceforge-YYYYMMDD.dump"
```

After restore, run the checks below against the isolated target. Keep the source
backup immutable throughout the drill.

## Repository Backup Preflight

```bash
export RECOVERY_ENV_FILE=/secure/path/voiceforge-recovery.env
export BACKUP_DIR=/secure/path/downloaded-db-backups
export DIRECT_URL='postgresql://isolated-or-live-connectivity-target'
node scripts/backup-validation.js --verbose
```

This preflight fails closed on missing inputs and verifies only recovery-env key
presence, a recent non-empty local artifact, and database connectivity. It does
not execute `pg_restore`, read the artifact, compare source/restored data, or
verify S3 knowledge objects. Do not record it as a successful restore drill.

## Restore Verification Checklist

- [ ] `corepack pnpm --filter @voiceforge/api exec prisma migrate status --schema=prisma/schema.prisma` reports the expected migration state against the restored target
- [ ] Critical-table row counts are captured before backup and match the restored target
- [ ] Foreign-key violations are zero (`pg_constraint` checks validated)
- [ ] Expected indexes are valid (`pg_index.indisvalid` is true)
- [ ] RLS is enabled and expected policies exist
- [ ] Representative tenant-scoped API reads succeed against the restored target
- [ ] Representative S3 knowledge objects exist and can be read by the recovery environment
- [ ] Recovery time and recovery point are recorded against the agreed RTO/RPO

## Supabase Managed Restore

Use Supabase Dashboard → Database → Backups and follow the restore options shown
for the active project plan. Restore to an isolated target first. Moving an
isolated restore into production is an incident-specific change requiring an
approved cutover plan; this repository cannot prescribe dashboard options that
are not enabled for the project.

## Migration Safety

Before running migrations in production:

1. Confirm a current managed or logical backup exists.
2. Restore and test it on an isolated target.
3. Deploy only through `.github/workflows/deploy-aws-ec2.yml`; it runs
   `prisma migrate status`, `prisma migrate deploy`, and `db-verify.ts` before
   replacing services.
4. Never run `prisma db push --accept-data-loss` or `--force-reset` in production.
5. Monitor the health gates and logs after deployment.

## Emergency Contacts

- Supabase Support: support@supabase.io
- Database incident: P1 via Supabase dashboard