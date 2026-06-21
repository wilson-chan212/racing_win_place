-- Per-race user annotations: cell highlights, freehand notes, manual odds.
create table if not exists public.race_annotations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null default '00000000-0000-4000-a000-000000000001'::uuid,
  race_date date not null,
  meeting_code text not null,
  race_no int not null,
  highlights jsonb not null default '{}'::jsonb,
  note_strokes jsonb not null default '[]'::jsonb,
  manual_odds jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (race_date, meeting_code, race_no)
);

create index if not exists race_annotations_race_idx
  on public.race_annotations (race_date, meeting_code, race_no);

alter table public.race_annotations enable row level security;

create policy race_annotations_single_tenant_all_anon on public.race_annotations
  for all to anon using (true) with check (true);

create policy race_annotations_single_tenant_all_authenticated on public.race_annotations
  for all to authenticated using (true) with check (true);
