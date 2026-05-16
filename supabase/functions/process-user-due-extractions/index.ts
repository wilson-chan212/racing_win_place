// Supabase Edge Function (Deno)
// POST with anon key — processes due pending jobs (single-tenant deployment).

import {
  createServiceSupabase,
  corsHeaders,
  ExtractRaceError,
  extractRaceOdds,
  json,
  readProjectSupabaseEnv,
  upsertLatestRaceResults,
  upsertRaceSnapshots
} from '../_shared/race-extraction.ts'

type ScheduledJob = {
  id: string
  created_by: string
  race_date: string
  meeting_code: string
  race_no: number
  scheduled_at: string | null
}

function errorText(e: unknown) {
  if (e instanceof ExtractRaceError) {
    return e.body.details ? `${e.body.error}: ${e.body.details}` : String(e.body.error ?? e.message)
  }
  return String(e instanceof Error ? e.message : e)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const env = readProjectSupabaseEnv()
    const supabase = createServiceSupabase(env)
    const nowIso = new Date().toISOString()

    const { data: dueJobs, error: dueErr } = await supabase
      .from('race_extraction_jobs')
      .select('id,created_by,race_date,meeting_code,race_no,scheduled_at')
      .eq('status', 'pending')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(10)

    if (dueErr) return json({ error: 'Failed to load due jobs', details: dueErr.message }, 500)

    const results: Array<{ id: string; ok: boolean; count?: number; error?: string }> = []

    for (const job of (dueJobs ?? []) as ScheduledJob[]) {
      const lockTime = new Date().toISOString()
      const { data: claimed, error: claimErr } = await supabase
        .from('race_extraction_jobs')
        .update({
          status: 'running',
          locked_at: lockTime,
          last_run_at: lockTime,
          attempt_count: 1
        })
        .eq('id', job.id)
        .eq('status', 'pending')
        .select('id,attempt_count')
        .maybeSingle()

      if (claimErr) {
        results.push({ id: job.id, ok: false, error: claimErr.message })
        continue
      }
      if (!claimed) continue

      try {
        const extractedAt = new Date().toISOString()
        const extracted = await extractRaceOdds(job.race_date, job.meeting_code, job.race_no)
        await upsertLatestRaceResults(supabase, {
          createdBy: job.created_by,
          raceDate: job.race_date,
          meetingCode: job.meeting_code,
          raceNo: job.race_no,
          sourceUrl: extracted.sourceUrl,
          rows: extracted.rows,
          extractedAt
        })
        await upsertRaceSnapshots(supabase, {
          jobId: job.id,
          createdBy: job.created_by,
          raceDate: job.race_date,
          meetingCode: job.meeting_code,
          raceNo: job.race_no,
          sourceUrl: extracted.sourceUrl,
          rows: extracted.rows,
          extractedAt
        })

        const { error: doneErr } = await supabase
          .from('race_extraction_jobs')
          .update({
            status: 'completed',
            completed_at: extractedAt,
            locked_at: null,
            last_error: null,
            updated_at: extractedAt
          })
          .eq('id', job.id)

        if (doneErr) throw doneErr
        results.push({ id: job.id, ok: true, count: extracted.rows.length })
      } catch (e) {
        const failedAt = new Date().toISOString()
        const message = errorText(e).slice(0, 1000)
        await supabase
          .from('race_extraction_jobs')
          .update({
            status: 'failed',
            locked_at: null,
            last_error: message,
            updated_at: failedAt
          })
          .eq('id', job.id)

        results.push({ id: job.id, ok: false, error: message })
      }
    }

    return json({
      ok: true,
      processed: results.length,
      results
    })
  } catch (e) {
    if (e instanceof ExtractRaceError) return json(e.body, e.status)
    return json({ error: 'Unexpected scheduler error', details: String(e) }, 500)
  }
})
