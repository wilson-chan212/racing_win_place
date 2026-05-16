-- Runner details shown in the odds table
alter table public.race_results
  add column if not exists barrier int,
  add column if not exists jockey_name text,
  add column if not exists trainer_name text;
