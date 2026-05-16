-- Mark horses that have withdrawn (退出) from a race
alter table public.race_results
  add column if not exists withdrawn boolean not null default false;

alter table public.race_extraction_snapshots
  add column if not exists withdrawn boolean not null default false;
