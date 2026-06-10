-- Personal deployment fixes: remove legacy failing cron, lock down scheduler RPC.

do $cron$
declare
  jid bigint;
begin
  for jid in
    select jobid from cron.job where jobname = 'process-scheduled-extractions-every-minute'
  loop
    perform cron.unschedule(jid);
  end loop;
end
$cron$;

revoke all on function public.invoke_process_user_due_extractions() from public;
revoke all on function public.invoke_process_user_due_extractions() from anon, authenticated;
grant execute on function public.invoke_process_user_due_extractions() to postgres;
