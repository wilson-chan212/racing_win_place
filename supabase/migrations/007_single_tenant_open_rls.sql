-- Single-tenant deployment: one logical dataset (no per-browser anonymous users).
-- After this migration, Edge Functions default created_by UUID matches DEFAULT below.
-- Optional override: Edge env SINGLE_TENANT_USER_ID

-- ── Policies (replace per-user RLS with open access via anon/authenticated JWT) ──
DROP POLICY IF EXISTS race_results_read_own ON public.race_results;
DROP POLICY IF EXISTS race_jobs_read_own ON public.race_extraction_jobs;
DROP POLICY IF EXISTS race_jobs_insert_own ON public.race_extraction_jobs;
DROP POLICY IF EXISTS race_jobs_delete_own_pending ON public.race_extraction_jobs;
DROP POLICY IF EXISTS race_jobs_update_own_pending ON public.race_extraction_jobs;
DROP POLICY IF EXISTS race_jobs_delete_own_finished ON public.race_extraction_jobs;
DROP POLICY IF EXISTS race_snapshots_read_own ON public.race_extraction_snapshots;
DROP POLICY IF EXISTS race_snapshots_delete_own ON public.race_extraction_snapshots;

CREATE POLICY race_results_single_tenant_all_anon ON public.race_results
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY race_results_single_tenant_all_authenticated ON public.race_results
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY race_jobs_single_tenant_all_anon ON public.race_extraction_jobs
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY race_jobs_single_tenant_all_authenticated ON public.race_extraction_jobs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY race_snapshots_single_tenant_all_anon ON public.race_extraction_snapshots
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY race_snapshots_single_tenant_all_authenticated ON public.race_extraction_snapshots
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Dedupe historical rows before global unique index on race (not per-user) ──
DELETE FROM public.race_results r
WHERE r.ctid IN (
  SELECT ctid FROM (
    SELECT ctid,
      ROW_NUMBER() OVER (
        PARTITION BY race_date, meeting_code, race_no, horse_no
        ORDER BY extracted_at DESC NULLS LAST, updated_at DESC NULLS LAST
      ) AS rn
    FROM public.race_results
  ) dedup WHERE dedup.rn > 1
);

DROP INDEX IF EXISTS public.race_results_unique_user_race_horse;

CREATE UNIQUE INDEX IF NOT EXISTS race_results_unique_race_horse
  ON public.race_results (race_date, meeting_code, race_no, horse_no);

-- ── One fixed owner UUID for created_by everywhere ──

UPDATE public.race_results SET created_by = '00000000-0000-4000-a000-000000000001'::uuid WHERE true;
UPDATE public.race_extraction_jobs SET created_by = '00000000-0000-4000-a000-000000000001'::uuid WHERE true;
UPDATE public.race_extraction_snapshots SET created_by = '00000000-0000-4000-a000-000000000001'::uuid WHERE true;

ALTER TABLE public.race_results ALTER COLUMN created_by SET DEFAULT '00000000-0000-4000-a000-000000000001'::uuid;
ALTER TABLE public.race_extraction_jobs ALTER COLUMN created_by SET DEFAULT '00000000-0000-4000-a000-000000000001'::uuid;
ALTER TABLE public.race_extraction_snapshots ALTER COLUMN created_by SET DEFAULT '00000000-0000-4000-a000-000000000001'::uuid;

ALTER TABLE public.race_results
  ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE public.race_extraction_jobs
  ALTER COLUMN created_by SET NOT NULL;
