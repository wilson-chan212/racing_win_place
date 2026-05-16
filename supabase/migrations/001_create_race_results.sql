-- Results per horse for a given race
create table if not exists public.race_results (
  id uuid primary key default gen_random_uuid(),
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
  extracted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists race_results_unique_race_horse
  on public.race_results (race_date, meeting_code, race_no, horse_no);

-- Jobs: user-configured extraction settings and schedules
create table if not exists public.race_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid,
  race_date date not null,
  meeting_code text not null,
  race_no int not null,
  scheduled_at timestamptz,
  status text not null default 'pending',
  last_error text,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists race_extraction_jobs_schedule_idx
  on public.race_extraction_jobs (scheduled_at, status);

-- RLS
alter table public.race_results enable row level security;
alter table public.race_extraction_jobs enable row level security;

-- Read allowed to authenticated users (UI)
do $$ begin
  create policy "race_results_read_authenticated"
    on public.race_results
    for select
    to authenticated
    using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "race_jobs_read_authenticated"
    on public.race_extraction_jobs
    for select
    to authenticated
    using (true);
exception when duplicate_object then null;
end $$;

-- Write policies are intentionally omitted; Edge Functions use service role.
