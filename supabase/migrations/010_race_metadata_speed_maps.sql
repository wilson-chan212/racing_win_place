-- Per-race metadata (e.g. Speed Map screenshot URL) — one row per race.
create table if not exists public.race_metadata (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null default '00000000-0000-4000-a000-000000000001'::uuid,
  race_date date not null,
  meeting_code text not null,
  race_no int not null,
  speed_map_url text,
  speed_map_source_url text,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (race_date, meeting_code, race_no)
);

create index if not exists race_metadata_race_idx
  on public.race_metadata (race_date, meeting_code, race_no);

alter table public.race_metadata enable row level security;

create policy race_metadata_single_tenant_all_anon on public.race_metadata
  for all to anon using (true) with check (true);

create policy race_metadata_single_tenant_all_authenticated on public.race_metadata
  for all to authenticated using (true) with check (true);

-- Public bucket for Speed Map PNG screenshots.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'speed_maps',
  'speed_maps',
  true,
  10485760,
  array['image/png', 'image/jpeg']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists speed_maps_public_read on storage.objects;
drop policy if exists speed_maps_service_insert on storage.objects;
drop policy if exists speed_maps_service_update on storage.objects;
drop policy if exists speed_maps_service_delete on storage.objects;

create policy speed_maps_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'speed_maps');

create policy speed_maps_service_insert on storage.objects
  for insert to service_role
  with check (bucket_id = 'speed_maps');

create policy speed_maps_service_update on storage.objects
  for update to service_role
  using (bucket_id = 'speed_maps')
  with check (bucket_id = 'speed_maps');

create policy speed_maps_service_delete on storage.objects
  for delete to service_role
  using (bucket_id = 'speed_maps');
