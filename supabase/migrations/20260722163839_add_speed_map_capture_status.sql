alter table public.race_metadata
  add column if not exists speed_map_status text not null default 'pending',
  add column if not exists speed_map_last_error text,
  add column if not exists speed_map_attempt_count int not null default 0,
  add column if not exists speed_map_next_retry_at timestamptz;

update public.race_metadata
set speed_map_status = case
  when speed_map_url is not null then 'completed'
  else 'pending'
end
where true;

alter table public.race_metadata
  drop constraint if exists race_metadata_speed_map_status_check;

alter table public.race_metadata
  add constraint race_metadata_speed_map_status_check
  check (speed_map_status in ('pending', 'capturing', 'completed', 'retrying', 'unavailable'));

create index if not exists race_metadata_speed_map_retry_idx
  on public.race_metadata (speed_map_status, speed_map_next_retry_at)
  where speed_map_url is null;
