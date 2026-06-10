// Supabase Edge Function (Deno)
// POST with header x-schedule-secret: <SCHEDULE_PROCESSOR_SECRET>
// Processes due public.race_extraction_jobs rows (optional manual / external cron).

import {
  corsHeaders,
  ExtractRaceError,
  createServiceSupabase,
  json,
  processDueExtractionJobs,
  readProjectSupabaseEnv
} from '../_shared/race-extraction.ts'

function hasValidProcessorSecret(req: Request) {
  const expected = Deno.env.get('SCHEDULE_PROCESSOR_SECRET')
  if (!expected) return false

  const headerSecret = req.headers.get('x-schedule-secret')
  const authHeader = req.headers.get('authorization') ?? ''
  const bearerSecret = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length).trim()
    : ''

  return headerSecret === expected || bearerSecret === expected
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!hasValidProcessorSecret(req)) return json({ error: 'Unauthorized scheduler' }, 401)

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
