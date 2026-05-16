// Supabase Edge Function (Deno)
// POST JSON: { raceDate: "YYYY-MM-DD", meetingCode: "S2", raceNo: 4 }
// Stores parsed win/place odds into public.race_results.

import {
  createServiceSupabase,
  corsHeaders,
  ExtractRaceError,
  extractRaceOdds,
  isISODate,
  json,
  readProjectSupabaseEnv,
  readSingleTenantUserId,
  safeInt,
  upsertLatestRaceResults
} from '../_shared/race-extraction.ts'

type ExtractRequest = {
  raceDate: string
  meetingCode: string
  raceNo: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    let payload: ExtractRequest
    try {
      payload = (await req.json()) as ExtractRequest
    } catch {
      return json({ error: 'Invalid JSON' }, 400)
    }

    const raceDate = String(payload.raceDate ?? '').trim()
    const meetingCode = String(payload.meetingCode ?? '').trim()
    const raceNo = safeInt(payload.raceNo)

    if (!isISODate(raceDate)) return json({ error: 'raceDate must be YYYY-MM-DD' }, 400)
    if (!meetingCode || meetingCode.length > 10) return json({ error: 'meetingCode invalid' }, 400)
    if (!raceNo || raceNo < 1 || raceNo > 99) return json({ error: 'raceNo invalid' }, 400)

    const env = readProjectSupabaseEnv()
    const userId = readSingleTenantUserId()
    const extracted = await extractRaceOdds(raceDate, meetingCode, raceNo)
    const supabase = createServiceSupabase(env)
    const data = await upsertLatestRaceResults(supabase, {
      createdBy: userId,
      raceDate,
      meetingCode,
      raceNo,
      sourceUrl: extracted.sourceUrl,
      rows: extracted.rows
    })

    return json({
      ok: true,
      sourceUrl: extracted.sourceUrl,
      count: data.length,
      sample: data.slice(0, 5)
    })
  } catch (e) {
    if (e instanceof ExtractRaceError) return json(e.body, e.status)
    return json({ error: 'Unexpected extraction error', details: String(e) }, 500)
  }
})
