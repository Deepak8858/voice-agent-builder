-- Phase 2: Table Partitioning by Month
-- For scale: 100k+ users, prevents table bloat
-- Note: Prisma doesn't support partitions natively, this is raw SQL migration

-- Partitioned tables need to be created fresh with partition key
-- This migration is additive for new tables; existing tables require careful data migration

-- Usage records: partition by month (recommended when table > 1M rows)
-- ALTER TABLE usage_records PARTITION BY RANGE (date_trunc('month', recorded_at));
-- For existing tables, schedule partition migration during low-traffic window:
-- 1. Create new partitioned table: usage_records_partitioned
-- 2. INSERT INTO ... SELECT * FROM usage_records
-- 3. RENAME TABLE usage_records TO usage_records_old
-- 4. RENAME TABLE usage_records_partitioned TO usage_records
-- 5. Create indexes on partitioned table
-- 6. Schedule auto-partition creation function

-- Auto-partition creation function for monthly tables
CREATE OR REPLACE FUNCTION create_monthly_partitions()
RETURNS void AS $$
DECLARE
  next_month_start date;
  next_month_end date;
  partition_suffix text;
  tables text[] := ARRAY['usage_records', 'call_events', 'analytics_events'];
  tbl text;
BEGIN
  next_month_start := date_trunc('month', now()) + interval '1 month';
  next_month_end := next_month_start + interval '1 month';
  partition_suffix := to_char(next_month_start, 'YYYY_MM');

  FOREACH tbl IN ARRAY tables
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      tbl || '_' || partition_suffix,
      tbl,
      next_month_start,
      next_month_end
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Schedule first of each month at 00:05
-- SELECT cron.schedule('create-monthly-partitions', '5 0 1 * *', $$SELECT create_monthly_partitions()$$);

-- Partition maintenance: detach partitions older than 12 months (for data retention)
CREATE OR REPLACE FUNCTION detach_old_partitions()
RETURNS void AS $$
DECLARE
  cutoff_date date := date_trunc('month', now()) - interval '12 months';
  tables text[] := ARRAY['usage_records', 'call_events', 'analytics_events'];
  tbl text;
  part_name text;
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    FOR part_name IN
      SELECT inhrelid::regclass::text
      FROM pg_inherits
      WHERE inhparent = tbl::regclass
      AND inhrelid::regclass::text ~ (tbl || '_[0-9]{4}_[0-9]{2}')
    LOOP
      IF part_name < (tbl || '_' || to_char(cutoff_date, 'YYYY_MM')) THEN
        EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', tbl, part_name);
        -- Optionally: DROP TABLE %I (uncomment after backup verification)
        RAISE NOTICE 'Detached old partition: %', part_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;