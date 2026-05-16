-- Ownership + per-user RLS (Anonymous Auth)

-- Add created_by columns
alter table public.race_results
  add column if not exists created_by uuid;

alter table public.race_extraction_jobs
  add column if not exists created_by uuid;

-- Update unique index so each user can store their own race results
drop index if exists public.race_results_unique_race_horse;
create unique index if not exists race_results_unique_user_race_horse
  on public.race_results (created_by, race_date, meeting_code, race_no, horse_no);

-- Ensure RLS is enabled
alter table public.race_results enable row level security;
alter table public.race_extraction_jobs enable row level security;

-- Replace broad read policies with per-user policies
drop policy if exists race_results_read_authenticated on public.race_results;
drop policy if exists race_jobs_read_authenticated on public.race_extraction_jobs;

do $$ begin
  create policy "race_results_read_own"
    on public.race_results
    for select
    to authenticated
    using (created_by = auth.uid());
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "race_jobs_read_own"
    on public.race_extraction_jobs
    for select
    to authenticated
    using (created_by = auth.uid());
exception when duplicate_object then null;
end $$;

-- Optional: allow users to insert their own jobs from the app (not used yet)
do $$ begin
  create policy "race_jobs_insert_own"
    on public.race_extraction_jobs
    for insert
    to authenticated
    with check (created_by = auth.uid());
exception when duplicate_object then null;
end $$;

