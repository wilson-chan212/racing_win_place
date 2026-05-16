-- Server-side scheduled odds extraction support.

alter table public.race_extraction_jobs
  add column if not exists locked_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists attempt_count int not null default 0;

alter table public.race_extraction_jobs
  drop constraint if exists race_extraction_jobs_status_check;

alter table public.race_extraction_jobs
  add constraint race_extraction_jobs_status_check
  check (status in ('pending', 'running', 'completed', 'failed', 'cancelled'));

create index if not exists race_extraction_jobs_due_idx
  on public.race_extraction_jobs (scheduled_at, status)
  where status = 'pending';

create table if not exists public.race_extraction_snapshots (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.race_extraction_jobs(id) on delete cascade,
  created_by uuid not null,
  race_date date not null,
  meeting_code text not null,
  race_no int not null,
  horse_no int,
  horse_name text,
  barrier int,
  jockey_name text,
  trainer_name text,
  win numeric,
  place numeric,
  source_url text not null,
  extracted_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists race_extraction_snapshots_job_horse_idx
  on public.race_extraction_snapshots (job_id, horse_no);

create index if not exists race_extraction_snapshots_user_race_idx
  on public.race_extraction_snapshots (created_by, race_date, meeting_code, race_no, extracted_at);

alter table public.race_extraction_snapshots enable row level security;

do $$ begin
  create policy "race_snapshots_read_own"
    on public.race_extraction_snapshots
    for select
    to authenticated
    using (created_by = auth.uid());
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "race_jobs_delete_own_pending"
    on public.race_extraction_jobs
    for delete
    to authenticated
    using (created_by = auth.uid() and status = 'pending');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "race_jobs_update_own_pending"
    on public.race_extraction_jobs
    for update
    to authenticated
    using (created_by = auth.uid() and status = 'pending')
    with check (created_by = auth.uid() and status in ('pending', 'cancelled'));
exception when duplicate_object then null;
end $$;
