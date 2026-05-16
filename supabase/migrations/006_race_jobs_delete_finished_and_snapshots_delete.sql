-- Allow users to delete completed / failed / cancelled extraction jobs (and cascade snapshots).

do $$ begin
  create policy "race_jobs_delete_own_finished"
    on public.race_extraction_jobs
    for delete
    to authenticated
    using (created_by = auth.uid() and status in ('completed', 'failed', 'cancelled'));
exception when duplicate_object then null;
end $$;

-- Child deletes during ON DELETE CASCADE must pass RLS.
do $$ begin
  create policy "race_snapshots_delete_own"
    on public.race_extraction_snapshots
    for delete
    to authenticated
    using (created_by = auth.uid());
exception when duplicate_object then null;
end $$;
