-- Run ONCE in Supabase Dashboard → SQL Editor (after migration 008).
-- Values: Dashboard → Project Settings → API → Project URL & anon public key.

-- Remove previous secrets if you are re-running (optional):
-- select vault.delete_secret(id) from vault.secrets where name in ('race_cron_project_url', 'race_cron_anon_key');

select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co',
  'race_cron_project_url',
  'Cron: project URL for scheduled odds extraction'
);

select vault.create_secret(
  'YOUR_SUPABASE_ANON_KEY',
  'race_cron_anon_key',
  'Cron: anon key to invoke process-user-due-extractions'
);

-- Verify cron job exists:
-- select jobid, jobname, schedule, active from cron.job where jobname = 'race-process-due-extractions';
