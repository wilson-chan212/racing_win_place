// Supabase Edge Function (Deno)
// POST with anon key — processes due pending jobs (single-tenant deployment).
// Also invoked every minute by pg_cron (see migration 008_schedule_processor_cron.sql).

import {
  corsHeaders,
  ExtractRaceError,
  createServiceSupabase,
  json,
  processDueExtractionJobs,
  readProjectSupabaseEnv
} from '../_shared/race-extraction.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const env = readProjectSupabaseEnv()
    const supabase = createServiceSupabase(env)
    const outcome = await processDueExtractionJobs(supabase)
    return json(outcome)
  } catch (e) {
    if (e instanceof ExtractRaceError) return json(e.body, e.status)
    return json({ error: 'Unexpected scheduler error', details: String(e) }, 500)
  }
})
