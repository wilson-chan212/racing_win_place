-- Server-side scheduler for 預定抄賠率 (runs without the website open).
-- One-time setup: run supabase/setup-cron-vault.sql with your project URL + anon key.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.invoke_process_user_due_extractions()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault, cron, pg_temp
as $$
declare
  project_url text;
  anon_key text;
  request_id bigint;
begin
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'race_cron_project_url'
  limit 1;

  select decrypted_secret into anon_key
  from vault.decrypted_secrets
  where name = 'race_cron_anon_key'
  limit 1;

  if project_url is null or anon_key is null then
    raise log 'invoke_process_user_due_extractions: missing vault secrets race_cron_project_url / race_cron_anon_key (see supabase/setup-cron-vault.sql)';
    return;
  end if;

  select net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/process-user-due-extractions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := '{}'::jsonb
  ) into request_id;
end;
$$;

revoke all on function public.invoke_process_user_due_extractions() from public;
revoke all on function public.invoke_process_user_due_extractions() from anon, authenticated;
grant execute on function public.invoke_process_user_due_extractions() to postgres;

do $cron$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'race-process-due-extractions'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end
$cron$;

select cron.schedule(
  'race-process-due-extractions',
  '* * * * *',
  $$select public.invoke_process_user_due_extractions();$$
);
