import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type ParsedOddsRow = {
  horse_no: number | null
  horse_name: string | null
  barrier: number | null
  jockey_name: string | null
  trainer_name: string | null
  win: number | null
  place: number | null
  withdrawn?: boolean
}

type HkjcOddsNode = {
  combString?: string | number | null
  oddsValue?: string | number | null
  bankerOdds?: {
    combString?: string | number | null
    oddsValue?: string | number | null
  } | null
}

type HkjcOddsPool = {
  oddsType?: string
  oddsNodes?: HkjcOddsNode[]
}

type HkjcRunner = {
  no?: string | number
  status?: string | null
  name_ch?: string | null
  name_en?: string | null
  /** Present on race-runner payload; HKJC serves even when pooled odds arrays are sparse. */
  winOdds?: string | number | null
  barrierDrawNumber?: string | number | null
  jockey?: {
    name_ch?: string | null
    name_en?: string | null
  } | null
  trainer?: {
    name_ch?: string | null
    name_en?: string | null
  } | null
}

/** HKJC marks scratched / withdrawn runners (退出) via status and empty barrier/jockey. */
export function isWithdrawnRunner(runner: HkjcRunner): boolean {
  const status = String(runner.status ?? '')
    .trim()
    .toLowerCase()
  if (
    status === 'scratched' ||
    status === 'scr' ||
    status === 'withdrawn' ||
    status === 'withdraw' ||
    status === 'removed' ||
    status.includes('scratch') ||
    status.includes('withdraw')
  ) {
    return true
  }

  const hasName = Boolean(runner.name_ch?.trim() || runner.name_en?.trim())
  if (!hasName) return false

  const barrier = safeInt(runner.barrierDrawNumber)
  const hasJockey = Boolean(runner.jockey?.name_ch?.trim() || runner.jockey?.name_en?.trim())
  if (barrier != null || hasJockey) return false
  if (toNumberOrNull(runner.winOdds) !== null) return false

  if (status === 'standby' || status === 'reserve' || status === 'res') return false
  if (status === 'declared' || status === 'active' || status === 'normal') return false

  // HKJC wp: scratched horses keep the name but clear barrier, jockey, and odds.
  return true
}

function applyWithdrawnRunner(row: ParsedOddsRow, runner: HkjcRunner) {
  row.withdrawn = true
  row.horse_name = runner.name_ch || runner.name_en || row.horse_name
  row.barrier = null
  row.jockey_name = null
  row.trainer_name = runner.trainer?.name_ch || runner.trainer?.name_en || row.trainer_name
  row.win = null
  row.place = null
}

export type ExtractedRaceOdds = {
  sourceUrl: string
  rows: ParsedOddsRow[]
  graphqlError: string | null
}

export type ProjectSupabaseEnv = {
  supabaseUrl: string
  serviceKey: string
  anonKey: string
}

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-schedule-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

export class ExtractRaceError extends Error {
  body: Record<string, unknown>
  status: number

  constructor(body: Record<string, unknown>, status = 500) {
    super(String(body.error ?? 'Extraction failed'))
    this.body = body
    this.status = status
  }
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  })
}

export function isISODate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

export function safeInt(v: unknown) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export function readProjectSupabaseEnv(): ProjectSupabaseEnv {
  // Supabase CLI blocks secret names starting with SUPABASE_, so we use PROJECT_*.
  const supabaseUrl = Deno.env.get('PROJECT_SUPABASE_URL')
  const serviceKey = Deno.env.get('PROJECT_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('PROJECT_SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceKey || !anonKey) {
    throw new ExtractRaceError({ error: 'Missing Supabase env' }, 500)
  }
  return { supabaseUrl, serviceKey, anonKey }
}

export function createServiceSupabase(env: ProjectSupabaseEnv) {
  return createClient(env.supabaseUrl, env.serviceKey, {
    auth: { persistSession: false }
  })
}

/** Single app tenant (must match migration default `created_by`). */
const DEFAULT_SINGLE_TENANT_USER_ID = '00000000-0000-4000-a000-000000000001'

export function readSingleTenantUserId(): string {
  const v = Deno.env.get('SINGLE_TENANT_USER_ID')?.trim()
  if (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v
  return DEFAULT_SINGLE_TENANT_USER_ID
}

export function buildUrl(raceDate: string, meetingCode: string, raceNo: number) {
  return `https://bet.hkjc.com/en/racing/wp/${raceDate}/${encodeURIComponent(meetingCode)}/${raceNo}`
}

export function buildSpeedMapUrl(raceNo: number) {
  return `https://racing.hkjc.com/zh-hk/local/info/speedpro/formguide?raceno=${raceNo}`
}

const SPEED_MAP_BUCKET = 'speed_maps'
const DEFAULT_SCREENSHOT_API_URL = 'https://production-sfo.browserless.io/chromium/screenshot'

/** HKJC SpeedPRO page shows venue in Chinese; map meeting codes from jobs. */
export function speedMapVenueHints(meetingCode: string): string[] {
  const code = meetingCode.trim().toUpperCase()
  if (code === 'HV' || code.startsWith('HV')) return ['跑馬地']
  if (code === 'ST' || code.startsWith('S')) return ['沙田']
  return []
}

/** Page header uses DD/MM/YYYY (e.g. 21/06/2026). */
export function speedMapDateLabels(raceDate: string): string[] {
  const m = raceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return [raceDate]
  const [, y, mo, d] = m
  return [
    `${d}/${mo}/${y}`,
    `${Number(d)}/${Number(mo)}/${y}`,
    `${d}/${mo}/${y.slice(2)}`
  ]
}

function readScreenshotConfig() {
  const apiKey = Deno.env.get('SCREENSHOT_API_KEY')?.trim()
  if (!apiKey) return null
  const apiUrl = Deno.env.get('SCREENSHOT_API_URL')?.trim() || DEFAULT_SCREENSHOT_API_URL
  return { apiKey, apiUrl }
}

function browserlessEndpoint(cfg: { apiKey: string; apiUrl: string }, path: 'screenshot' | 'content') {
  const base = cfg.apiUrl.replace(/\/(screenshot|function|content)\/?$/i, '')
  const url = `${base}/${path}`
  if (url.includes('token=')) return url
  if (url.includes('browserless.io')) {
    const joiner = url.includes('?') ? '&' : '?'
    return `${url}${joiner}token=${encodeURIComponent(cfg.apiKey)}`
  }
  return url
}

function screenshotApiHeaders(cfg: { apiKey: string; apiUrl: string }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!cfg.apiUrl.includes('browserless.io') && !cfg.apiUrl.includes('token=')) {
    headers.Authorization = `Bearer ${cfg.apiKey}`
  }
  return headers
}

function buildSpeedMapWaitFn(params: { raceDate: string; meetingCode: string; raceNo: number }) {
  const dateLabels = speedMapDateLabels(params.raceDate)
  const venueHints = speedMapVenueHints(params.meetingCode)
  return `() => {
    const t = document.body?.innerText ?? "";
    if (/正在加載|loading/i.test(t)) return false;
    if (!/走位圖|SPEED\\s*MAP/i.test(t)) return false;
    const dates = ${JSON.stringify(dateLabels)};
    if (!dates.some((d) => t.includes(d))) return false;
    const venues = ${JSON.stringify(venueHints)};
    if (venues.length && !venues.some((v) => t.includes(v))) return false;
    const urlNo = Number(new URL(location.href).searchParams.get("raceno"));
    return urlNo === ${params.raceNo};
  }`
}

async function captureValidatedSpeedMapImage(
  sourceUrl: string,
  params: { raceDate: string; meetingCode: string; raceNo: number }
): Promise<Uint8Array> {
  const cfg = readScreenshotConfig()
  if (!cfg) throw new Error('SCREENSHOT_API_KEY not configured')

  const res = await fetch(browserlessEndpoint(cfg, 'screenshot'), {
    method: 'POST',
    headers: screenshotApiHeaders(cfg),
    body: JSON.stringify({
      url: sourceUrl,
      gotoOptions: { waitUntil: 'networkidle2', timeout: 60_000 },
      waitForFunction: { fn: buildSpeedMapWaitFn(params), timeout: 45_000 },
      waitForTimeout: 3000,
      viewport: { width: 1500, height: 900 },
      options: {
        type: 'png',
        fullPage: false,
        clip: { x: 0, y: 0, width: 1480, height: 580 }
      }
    })
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Screenshot API failed (${res.status}): ${detail.slice(0, 300)}`)
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength < 500) throw new Error('Screenshot API returned empty image')
  return buf
}

function speedMapStoragePath(raceDate: string, meetingCode: string, raceNo: number) {
  return `${raceDate}/${meetingCode}_R${raceNo}.png`
}

/** Capture HKJC Speed Map once per race (first scheduled extraction only). */
export async function ensureSpeedMapCaptured(
  supabase: ReturnType<typeof createClient>,
  params: {
    createdBy: string
    raceDate: string
    meetingCode: string
    raceNo: number
  }
): Promise<{ captured: boolean; speedMapUrl?: string; skipped?: boolean }> {
  const { raceDate, meetingCode, raceNo, createdBy } = params

  const { data: existing, error: readErr } = await supabase
    .from('race_metadata')
    .select('speed_map_url,speed_map_attempt_count,speed_map_next_retry_at')
    .eq('race_date', raceDate)
    .eq('meeting_code', meetingCode)
    .eq('race_no', raceNo)
    .maybeSingle()

  if (readErr) throw new ExtractRaceError({ error: 'Failed to read race_metadata', details: readErr.message }, 500)
  if (existing?.speed_map_url) {
    return { captured: false, skipped: true, speedMapUrl: existing.speed_map_url }
  }

  const sourceUrl = buildSpeedMapUrl(raceNo)
  const attemptCount = Number(existing?.speed_map_attempt_count ?? 0) + 1
  const startedAt = new Date().toISOString()

  const { error: capturingErr } = await supabase.from('race_metadata').upsert(
    {
      created_by: createdBy,
      race_date: raceDate,
      meeting_code: meetingCode,
      race_no: raceNo,
      speed_map_status: 'capturing',
      speed_map_source_url: sourceUrl,
      speed_map_last_error: null,
      speed_map_attempt_count: attemptCount,
      speed_map_next_retry_at: null,
      updated_at: startedAt
    },
    { onConflict: 'race_date,meeting_code,race_no' }
  )

  if (capturingErr) {
    throw new ExtractRaceError({ error: 'Failed to mark speed map as capturing', details: capturingErr.message }, 500)
  }

  try {
    if (!readScreenshotConfig()) throw new Error('SCREENSHOT_API_KEY not configured')

    await assertHkjcRaceExistsForSpeedMap(raceDate, meetingCode, raceNo)

    const imageBytes = await captureValidatedSpeedMapImage(sourceUrl, { raceDate, meetingCode, raceNo })
    const storagePath = speedMapStoragePath(raceDate, meetingCode, raceNo)

    const { error: uploadErr } = await supabase.storage.from(SPEED_MAP_BUCKET).upload(storagePath, imageBytes, {
      contentType: 'image/png',
      upsert: true
    })

    if (uploadErr) throw new ExtractRaceError({ error: 'Speed map upload failed', details: uploadErr.message }, 500)

    const { data: publicUrlData } = supabase.storage.from(SPEED_MAP_BUCKET).getPublicUrl(storagePath)
    const speedMapUrl = publicUrlData.publicUrl
    const capturedAt = new Date().toISOString()

    const { error: upsertErr } = await supabase.from('race_metadata').upsert(
      {
        created_by: createdBy,
        race_date: raceDate,
        meeting_code: meetingCode,
        race_no: raceNo,
        speed_map_url: speedMapUrl,
        speed_map_source_url: sourceUrl,
        speed_map_status: 'completed',
        speed_map_last_error: null,
        speed_map_next_retry_at: null,
        captured_at: capturedAt,
        updated_at: capturedAt
      },
      { onConflict: 'race_date,meeting_code,race_no' }
    )

    if (upsertErr) {
      throw new ExtractRaceError({ error: 'Failed to save race_metadata', details: upsertErr.message }, 500)
    }

    return { captured: true, speedMapUrl }
  } catch (e) {
    const message = formatExtractionError(e).slice(0, 1000)
    const unavailable = /尚未|未有|未發布|not published|頁面未載入走位圖/i.test(message)
    const retryMinutes = attemptCount <= 1 ? 1 : attemptCount === 2 ? 3 : 10
    const failedAt = new Date().toISOString()
    const nextRetryAt = new Date(Date.now() + retryMinutes * 60_000).toISOString()

    await supabase
      .from('race_metadata')
      .update({
        speed_map_status: unavailable ? 'unavailable' : 'retrying',
        speed_map_last_error: message,
        speed_map_next_retry_at: nextRetryAt,
        updated_at: failedAt
      })
      .eq('race_date', raceDate)
      .eq('meeting_code', meetingCode)
      .eq('race_no', raceNo)

    throw e
  }
}

type SpeedMapRaceRef = {
  createdBy: string
  raceDate: string
  meetingCode: string
  raceNo: number
}

function uniqueRacesSorted(races: SpeedMapRaceRef[]): SpeedMapRaceRef[] {
  const byKey = new Map<string, SpeedMapRaceRef>()
  for (const race of races) {
    const key = `${race.raceDate}|${race.meetingCode}|${race.raceNo}`
    if (!byKey.has(key)) byKey.set(key, race)
  }
  return [...byKey.values()].sort((a, b) => {
    const byDate = b.raceDate.localeCompare(a.raceDate)
    if (byDate !== 0) return byDate
    const byMeeting = a.meetingCode.localeCompare(b.meetingCode)
    if (byMeeting !== 0) return byMeeting
    return a.raceNo - b.raceNo
  })
}

async function hasSpeedMapUrl(supabase: ReturnType<typeof createClient>, race: SpeedMapRaceRef) {
  const { data } = await supabase
    .from('race_metadata')
    .select('speed_map_url')
    .eq('race_date', race.raceDate)
    .eq('meeting_code', race.meetingCode)
    .eq('race_no', race.raceNo)
    .maybeSingle()
  return Boolean(data?.speed_map_url)
}

async function ensurePendingSpeedMapMetadata(
  supabase: ReturnType<typeof createClient>,
  race: SpeedMapRaceRef
) {
  const { data } = await supabase
    .from('race_metadata')
    .select('id')
    .eq('race_date', race.raceDate)
    .eq('meeting_code', race.meetingCode)
    .eq('race_no', race.raceNo)
    .maybeSingle()

  if (data) return

  await supabase.from('race_metadata').insert({
    created_by: race.createdBy,
    race_date: race.raceDate,
    meeting_code: race.meetingCode,
    race_no: race.raceNo,
    speed_map_status: 'pending',
    speed_map_source_url: buildSpeedMapUrl(race.raceNo)
  })
}

async function speedMapRetryIsDue(
  supabase: ReturnType<typeof createClient>,
  race: SpeedMapRaceRef
) {
  const { data } = await supabase
    .from('race_metadata')
    .select('speed_map_url,speed_map_status,speed_map_next_retry_at,updated_at')
    .eq('race_date', race.raceDate)
    .eq('meeting_code', race.meetingCode)
    .eq('race_no', race.raceNo)
    .maybeSingle()

  if (data?.speed_map_url) return false
  if (
    data?.speed_map_status === 'capturing' &&
    data.updated_at &&
    new Date(data.updated_at).getTime() > Date.now() - 2 * 60_000
  ) {
    return false
  }
  if (!data?.speed_map_next_retry_at) return true
  return new Date(data.speed_map_next_retry_at).getTime() <= Date.now()
}

/** Capture at most two missing speed maps per invocation. */
async function captureMissingSpeedMaps(
  supabase: ReturnType<typeof createClient>,
  races: SpeedMapRaceRef[],
  limit = 2
) {
  let attempted = 0
  for (const race of uniqueRacesSorted(races)) {
    if (attempted >= limit) break
    if (!(await speedMapRetryIsDue(supabase, race))) continue
    attempted += 1

    try {
      await ensureSpeedMapCaptured(supabase, race)
    } catch (e) {
      console.error(
        `Speed map capture failed for ${race.raceDate}|${race.meetingCode}|R${race.raceNo}:`,
        formatExtractionError(e)
      )
    }
  }
}

async function loadRacesMissingSpeedMapsFromCompletedJobs(
  supabase: ReturnType<typeof createClient>
): Promise<SpeedMapRaceRef[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: jobs, error } = await supabase
    .from('race_extraction_jobs')
    .select('created_by,race_date,meeting_code,race_no')
    .eq('status', 'completed')
    .gte('completed_at', since)

  if (error || !jobs?.length) return []

  const missing: SpeedMapRaceRef[] = []
  const races = jobs.map((job) => ({
    createdBy: job.created_by,
    raceDate: job.race_date,
    meetingCode: job.meeting_code,
    raceNo: job.race_no
  }))

  for (const race of uniqueRacesSorted(races)) {
    if (!(await hasSpeedMapUrl(supabase, race))) {
      await ensurePendingSpeedMapMetadata(supabase, race)
      missing.push(race)
    }
  }
  return missing
}

/** HKJC meeting `date` may be "YYYY-MM-DD" or ISO; compare as calendar day in HK. */
function normalizeHkjcMeetingDate(d: unknown): string | null {
  if (d == null || d === '') return null
  const s = String(d).trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** Map pooled combString variants (digits, composites) to starter horse numbers. */
function horseNoFromOddsComb(combString: unknown): number | null {
  if (combString === null || combString === undefined || combString === '') return null
  const trimmed = String(combString).trim()
  if (!trimmed) return null
  const primary = trimmed.match(/^(\d+)/)
  return primary?.[1] ? safeInt(primary[1]) : null
}

const HKJC_GRAPHQL_URL = 'https://info.cld.hkjc.com/graphql/base/'

/** HKJC CDN often denies or withholds pools without www/hkjc referrer headers after site refresh. */
/** Base headers; GraphQL calls merge a race-page Referer (HKJC often rejects generic referers with WHITELIST_ERROR). */
const HKJC_FETCH_HEADERS_BASE = {
  Accept: 'application/json',
  'Accept-Language': 'en-HK,en;q=0.9,zh-HK;q=0.8',
  'Content-Type': 'application/json',
  Origin: 'https://bet.hkjc.com',
  Referer: 'https://bet.hkjc.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
} as const

const HKJC_HTML_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-HK,en;q=0.9,zh-HK;q=0.8',
  Origin: 'https://bet.hkjc.com',
  Referer: 'https://bet.hkjc.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
} as const

export async function extractRaceOdds(raceDate: string, meetingCode: string, raceNo: number): Promise<ExtractedRaceOdds> {
  const sourceUrl = buildUrl(raceDate, meetingCode, raceNo)

  let parsed: ParsedOddsRow[] = []
  let graphqlError: string | null = null
  try {
    parsed = await fetchGraphqlOdds(raceDate, meetingCode, raceNo)
  } catch (e) {
    const msg = String(e)
    graphqlError = msg
  }

  if (!parsed.length) {
    let html: string
    try {
      const res = await fetch(sourceUrl, {
        cache: 'no-store',
        headers: {
          ...HKJC_HTML_HEADERS,
          Referer: sourceUrl
        }
      })
      if (!res.ok) throw new ExtractRaceError({ error: `HKJC fetch failed: ${res.status}`, graphqlError }, 502)
      html = await res.text()
    } catch (e) {
      if (e instanceof ExtractRaceError) throw e
      throw new ExtractRaceError({ error: 'HKJC fetch error', details: String(e), graphqlError }, 502)
    }

    parsed = parseOdds(html)
  }

  if (!parsed.length) {
    const detailHints = graphqlError
      ? `${graphqlError}（請核對賽馬日、會場、場次是否與馬會一致）`
      : `開盤後或馬會網頁顯示獨贏／位置數字後再試 · ${sourceUrl}`
    throw new ExtractRaceError(
      {
        error: '馬會尚未公佈賠率',
        details: detailHints,
        sourceUrl,
        graphqlError
      },
      422
    )
  }

  return { sourceUrl, rows: parsed, graphqlError }
}

export async function upsertLatestRaceResults(
  supabase: ReturnType<typeof createClient>,
  params: {
    createdBy: string
    raceDate: string
    meetingCode: string
    raceNo: number
    sourceUrl: string
    rows: ParsedOddsRow[]
    extractedAt?: string
  }
) {
  const extractedAt = params.extractedAt ?? new Date().toISOString()
  const rows = params.rows.map((r) => ({
    created_by: params.createdBy,
    race_date: params.raceDate,
    meeting_code: params.meetingCode,
    race_no: params.raceNo,
    horse_no: r.horse_no,
    horse_name: r.horse_name,
    barrier: r.withdrawn ? null : r.barrier,
    jockey_name: r.withdrawn ? null : r.jockey_name,
    trainer_name: r.trainer_name,
    win: r.withdrawn ? null : r.win,
    place: r.withdrawn ? null : r.place,
    withdrawn: Boolean(r.withdrawn),
    source_url: params.sourceUrl,
    extracted_at: extractedAt,
    updated_at: extractedAt
  }))

  const { data, error } = await supabase
    .from('race_results')
    .upsert(rows, { onConflict: 'race_date,meeting_code,race_no,horse_no' })
    .select(
      'race_date,meeting_code,race_no,horse_no,horse_name,barrier,jockey_name,trainer_name,win,place,withdrawn'
    )

  if (error) throw new ExtractRaceError({ error: 'DB upsert failed', details: error.message }, 500)
  return data ?? []
}

export async function upsertRaceSnapshots(
  supabase: ReturnType<typeof createClient>,
  params: {
    jobId: string
    createdBy: string
    raceDate: string
    meetingCode: string
    raceNo: number
    sourceUrl: string
    rows: ParsedOddsRow[]
    extractedAt?: string
  }
) {
  const extractedAt = params.extractedAt ?? new Date().toISOString()
  const rows = params.rows.map((r) => ({
    job_id: params.jobId,
    created_by: params.createdBy,
    race_date: params.raceDate,
    meeting_code: params.meetingCode,
    race_no: params.raceNo,
    horse_no: r.horse_no,
    horse_name: r.horse_name,
    barrier: r.withdrawn ? null : r.barrier,
    jockey_name: r.withdrawn ? null : r.jockey_name,
    trainer_name: r.trainer_name,
    win: r.withdrawn ? null : r.win,
    place: r.withdrawn ? null : r.place,
    withdrawn: Boolean(r.withdrawn),
    source_url: params.sourceUrl,
    extracted_at: extractedAt
  }))

  const { data, error } = await supabase
    .from('race_extraction_snapshots')
    .upsert(rows, { onConflict: 'job_id,horse_no' })
    .select('id')

  if (error) throw new ExtractRaceError({ error: 'Snapshot upsert failed', details: error.message }, 500)
  return data ?? []
}

export type DueJobResult = { id: string; ok: boolean; count?: number; error?: string }

type ScheduledJob = {
  id: string
  created_by: string
  race_date: string
  meeting_code: string
  race_no: number
  scheduled_at: string | null
}

export function formatExtractionError(e: unknown): string {
  if (e instanceof ExtractRaceError) {
    return e.body.details ? `${e.body.error}: ${e.body.details}` : String(e.body.error ?? e.message)
  }
  return String(e instanceof Error ? e.message : e)
}

/** Jobs left in `running` after a timeout/crash are eligible to run again. */
async function recoverStaleRunningJobs(
  supabase: ReturnType<typeof createClient>,
  staleMinutes = 10
) {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString()
  await supabase
    .from('race_extraction_jobs')
    .update({
      status: 'pending',
      locked_at: null,
      last_error: 'Previous run timed out; will retry',
      updated_at: new Date().toISOString()
    })
    .eq('status', 'running')
    .lt('locked_at', cutoff)
}

/** Process pending jobs whose scheduled_at has passed (browser or pg_cron). */
export async function processDueExtractionJobs(
  supabase: ReturnType<typeof createClient>,
  options?: { batchSize?: number; maxBatches?: number }
): Promise<{ ok: true; processed: number; results: DueJobResult[] }> {
  const batchSize = options?.batchSize ?? 5
  const maxBatches = options?.maxBatches ?? 4
  const allResults: DueJobResult[] = []

  await recoverStaleRunningJobs(supabase)

  for (let batch = 0; batch < maxBatches; batch++) {
    const nowIso = new Date().toISOString()
    const { data: dueJobs, error: dueErr } = await supabase
      .from('race_extraction_jobs')
      .select('id,created_by,race_date,meeting_code,race_no,scheduled_at')
      .eq('status', 'pending')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(batchSize)

    if (dueErr) throw new ExtractRaceError({ error: 'Failed to load due jobs', details: dueErr.message }, 500)
    if (!dueJobs?.length) break

    for (const job of dueJobs as ScheduledJob[]) {
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
        allResults.push({ id: job.id, ok: false, error: claimErr.message })
        continue
      }
      if (!claimed) continue

      try {
        const extractedAt = new Date().toISOString()
        // Always fetch fresh odds from HKJC at job time — never read or mirror race_results (即時賠率).
        const extracted = await extractRaceOdds(job.race_date, job.meeting_code, job.race_no)
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
        allResults.push({ id: job.id, ok: true, count: extracted.rows.length })
      } catch (e) {
        const failedAt = new Date().toISOString()
        const message = formatExtractionError(e).slice(0, 1000)
        await supabase
          .from('race_extraction_jobs')
          .update({
            status: 'failed',
            locked_at: null,
            last_error: message,
            updated_at: failedAt
          })
          .eq('id', job.id)

        allResults.push({ id: job.id, ok: false, error: message })
      }
    }

    if (dueJobs.length < batchSize) break
  }

  const missingRaces = await loadRacesMissingSpeedMapsFromCompletedJobs(supabase)
  if (missingRaces.length) {
    await captureMissingSpeedMaps(supabase, missingRaces, 2)
  }

  return { ok: true, processed: allResults.length, results: allResults }
}

/** Must match HKJC's allowlisted operation shape (see horseOddsQuery in community hkjc-api). Extra top-level fields → WHITELIST_ERROR. */
const HKJC_ODDS_QUERY = `
query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
 raceMeetings(date: $date, venueCode: $venueCode) {
 pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
 id
 status
 sellStatus
 oddsType
 lastUpdateTime
 guarantee
 minTicketCost
 name_en
 name_ch
 leg {
 number
 races
 }
 cWinSelections {
 composite
 name_ch
 name_en
 starters
 }
 oddsNodes {
 combString
 oddsValue
 hotFavourite
 oddsDropValue
 bankerOdds {
 combString
 oddsValue
 }
 }
 }
 }
}`

const HKJC_RACE_QUERY = `
fragment raceFragment on Race {
 id
 no
 status
 raceName_en
 raceName_ch
 postTime
 country_en
 country_ch
 distance
 wageringFieldSize
 go_en
 go_ch
 ratingType
 raceTrack {
 description_en
 description_ch
 }
 raceCourse {
 description_en
 description_ch
 displayCode
 }
 claCode
 raceClass_en
 raceClass_ch
 judgeSigns {
 value_en
 }
}

fragment racingBlockFragment on RaceMeeting {
 jpEsts: pmPools(
 oddsTypes: [WIN, PLA, TCE, TRI, FF, QTT, DT, TT, SixUP]
 filters: ["jackpot", "estimatedDividend"]
 ) {
 leg {
 number
 races
 }
 oddsType
 jackpot
 estimatedDividend
 mergedPoolId
 }
 poolInvs: pmPools(
 oddsTypes: [WIN, PLA, QIN, QPL, CWA, CWB, CWC, IWN, FCT, TCE, TRI, FF, QTT, DBL, TBL, DT, TT, SixUP]
 ) {
 id
 leg {
 races
 }
 }
 penetrometerReadings(filters: ["first"]) {
 reading
 readingTime
 }
 hammerReadings(filters: ["first"]) {
 reading
 readingTime
 }
 changeHistories(filters: ["top3"]) {
 type
 time
 raceNo
 runnerNo
 horseName_ch
 horseName_en
 jockeyName_ch
 jockeyName_en
 scratchHorseName_ch
 scratchHorseName_en
 handicapWeight
 scrResvIndicator
 }
}

query raceMeetings($date: String, $venueCode: String) {
 timeOffset {
 rc
 }
 activeMeetings: raceMeetings {
 id
 venueCode
 date
 status
 races {
 no
 postTime
 status
 wageringFieldSize
 }
 }
 raceMeetings(date: $date, venueCode: $venueCode) {
 id
 status
 venueCode
 date
 totalNumberOfRace
 currentNumberOfRace
 dateOfWeek
 meetingType
 totalInvestment
 country {
 code
 namech
 nameen
 seq
 }
 races {
 ...raceFragment
 runners {
 id
 no
 standbyNo
 status
 name_ch
 name_en
 horse {
 id
 code
 }
 color
 barrierDrawNumber
 handicapWeight
 currentWeight
 currentRating
 internationalRating
 gearInfo
 racingColorFileName
 allowance
 trainerPreference
 last6run
 saddleClothNo
 trumpCard
 priority
 finalPosition
 deadHeat
 winOdds
 jockey {
 code
 name_en
 name_ch
 }
 trainer {
 code
 name_en
 name_ch
 }
 }
 }
 obSt: pmPools(oddsTypes: [WIN, PLA]) {
 leg {
 races
 }
 oddsType
 comingleStatus
 }
 poolInvs: pmPools(
 oddsTypes: [WIN, PLA, QIN, QPL, CWA, CWB, CWC, IWN, FCT, TCE, TRI, FF, QTT, DBL, TBL, DT, TT, SixUP]
 ) {
 id
 leg {
 number
 races
 }
 status
 sellStatus
 oddsType
 investment
 mergedPoolId
 lastUpdateTime
 }
 ...racingBlockFragment
 pmPools(oddsTypes: []) {
 id
 }
 jkcInstNo: foPools(oddsTypes: [JKC], filters: ["top"]) {
 instNo
 }
 tncInstNo: foPools(oddsTypes: [TNC], filters: ["top"]) {
 instNo
 }
 }
}`

async function fetchHkjcGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options?: { operationName?: string; referer?: string }
) {
  const referer = options?.referer ?? HKJC_FETCH_HEADERS_BASE.Referer
  const payload: Record<string, unknown> = { query, variables }
  if (options?.operationName) payload.operationName = options.operationName

  const res = await fetch(HKJC_GRAPHQL_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...HKJC_FETCH_HEADERS_BASE,
      Referer: referer
    },
    body: JSON.stringify(payload)
  })

  if (!res.ok) throw new Error(`HKJC GraphQL failed: ${res.status}`)

  const body = await res.json()
  if (body?.errors?.length) {
    const msgs = body.errors.map((e: { message?: string }) => e.message ?? 'GraphQL error').join('; ')
    throw new Error(msgs)
  }

  return body?.data as T
}

/** Pre-check via HKJC GraphQL before opening SpeedPRO in a browser. */
async function assertHkjcRaceExistsForSpeedMap(raceDate: string, meetingCode: string, raceNo: number) {
  const racePageReferer = buildUrl(raceDate, meetingCode, raceNo)

  const raceData = await fetchHkjcGraphql<{
    raceMeetings?: Array<{
      date?: string | null
      venueCode?: string | null
      races?: Array<{ no?: string | number }>
    }>
  }>(
    HKJC_RACE_QUERY,
    { date: raceDate, venueCode: meetingCode },
    { operationName: 'raceMeetings', referer: racePageReferer }
  )

  const meeting = raceData?.raceMeetings?.[0]
  if (!meeting) {
    throw new Error(`馬會未有 ${raceDate} ${meetingCode} 賽事（走位圖暫不截取）`)
  }

  const race = meeting.races?.find((r) => safeInt(r.no) === raceNo)
  if (!race) {
    throw new Error(`馬會未有 ${raceDate} ${meetingCode} 第${raceNo}場（走位圖暫不截取）`)
  }
}

async function fetchGraphqlOdds(raceDate: string, meetingCode: string, raceNo: number) {
  const racePageReferer = buildUrl(raceDate, meetingCode, raceNo)

  const oddsData = await fetchHkjcGraphql<{
    raceMeetings?: Array<{
      date?: string | null
      venueCode?: string | null
      pmPools?: HkjcOddsPool[]
    }>
  }>(
    HKJC_ODDS_QUERY,
    {
      date: raceDate,
      venueCode: meetingCode,
      raceNo,
      oddsTypes: ['WIN', 'PLA']
    },
    { operationName: 'racing', referer: racePageReferer }
  )

  const meeting = oddsData?.raceMeetings?.[0]
  if (!meeting) return []

  const apiDateNorm = normalizeHkjcMeetingDate(meeting.date)
  const poolsEarly = meeting.pmPools ?? []
  const poolHasNodes = poolsEarly.some((p) => (p.oddsNodes?.length ?? 0) > 0)
  if (!apiDateNorm) {
    if (!poolsEarly.length) return []
    if (poolHasNodes) {
      // Odds query omits meeting `date` (allowlist); rows in pmPools ⇒ trust request vars.
    } else {
      // Pools returned but zero odds lines (suspend/closed/off-day/wrong fixture) — not a calendar mismatch.
      return []
    }
  } else if (apiDateNorm !== raceDate) {
    // HKJC `meeting.date` can be one calendar day off from the WP URL date (e.g. night card / session).
    // If pools are empty, skip GraphQL odds and fall back to HTML scrape using the requested URL date.
    if (!poolsEarly.length) return []
    if (!poolHasNodes) return []
    // Otherwise odds nodes exist for this (raceDate, venue, race) — use them despite card date drift.
  }

  let runners: HkjcRunner[] = []
  try {
    const raceData = await fetchHkjcGraphql<{
      raceMeetings?: Array<{
        races?: Array<{ no?: string | number; runners?: HkjcRunner[] }>
      }>
    }>(
      HKJC_RACE_QUERY,
      { date: raceDate, venueCode: meetingCode },
      { operationName: 'raceMeetings', referer: racePageReferer }
    )

    runners = raceData?.raceMeetings?.[0]?.races?.find((r) => safeInt(r.no) === raceNo)?.runners ?? []
  } catch {
    // Odds are still useful if HKJC rejects the broader runner-info query.
  }

  const pools = meeting.pmPools ?? []
  const runnerDetails = new Map<
    number,
    {
      horse_name: string | null
      barrier: number | null
      jockey_name: string | null
      trainer_name: string | null
    }
  >()

  for (const runner of runners) {
    const no = safeInt(runner.no)
    if (!no) continue

    if (isWithdrawnRunner(runner)) {
      runnerDetails.set(no, {
        horse_name: runner.name_ch || runner.name_en || null,
        barrier: null,
        jockey_name: null,
        trainer_name: runner.trainer?.name_ch || runner.trainer?.name_en || null
      })
      continue
    }

    runnerDetails.set(no, {
      horse_name: runner.name_ch || runner.name_en || null,
      barrier: safeInt(runner.barrierDrawNumber),
      jockey_name: runner.jockey?.name_ch || runner.jockey?.name_en || null,
      trainer_name: runner.trainer?.name_ch || runner.trainer?.name_en || null
    })
  }

  const byHorseNo = new Map<number, ParsedOddsRow>()

  const ensureRow = (horseNo: number): ParsedOddsRow =>
    byHorseNo.get(horseNo) ??
    ({
      horse_no: horseNo,
      horse_name: runnerDetails.get(horseNo)?.horse_name ?? null,
      barrier: runnerDetails.get(horseNo)?.barrier ?? null,
      jockey_name: runnerDetails.get(horseNo)?.jockey_name ?? null,
      trainer_name: runnerDetails.get(horseNo)?.trainer_name ?? null,
      win: null,
      place: null
    } satisfies ParsedOddsRow)

  const applyOddsNode = (
    oddsTypeUpper: string,
    node: { combString?: unknown; oddsValue?: string | number | null }
  ) => {
    const horseNo = horseNoFromOddsComb(node.combString)
    if (!horseNo) return
    const current = ensureRow(horseNo)
    if (oddsTypeUpper === 'WIN') current.win = toNumberOrNull(node.oddsValue)
    if (oddsTypeUpper === 'PLA') current.place = toNumberOrNull(node.oddsValue)
    byHorseNo.set(horseNo, current)
  }

  for (const pool of pools) {
    const oddsType = pool.oddsType?.toUpperCase()
    if (oddsType !== 'WIN' && oddsType !== 'PLA') continue

    for (const node of pool.oddsNodes ?? []) {
      applyOddsNode(oddsType, node)
      const b = node.bankerOdds
      if (b && ((b.combString != null && `${b.combString}`.trim() !== '') || (b.oddsValue != null && `${b.oddsValue}`.trim() !== ''))) {
        applyOddsNode(oddsType, b)
      }
    }
  }

  /** When pmPools omit oddsNodes, runner winOdds is often still advertised on the Race query. */
  for (const runner of runners) {
    const no = safeInt(runner.no)
    if (!no) continue
    if (isWithdrawnRunner(runner)) {
      const current = ensureRow(no)
      applyWithdrawnRunner(current, runner)
      byHorseNo.set(no, current)
      continue
    }
    const current = ensureRow(no)
    const w = toNumberOrNull(runner.winOdds)
    if (w !== null && current.win === null) current.win = w
    byHorseNo.set(no, current)
  }

  const rows = [...byHorseNo.values()].filter(
    (r) =>
      r.withdrawn ||
      (r.horse_no != null && runnerDetails.has(r.horse_no)) ||
      r.win !== null ||
      r.place !== null
  )
  const hasAnyOdds = rows.some((r) => !r.withdrawn && (r.win !== null || r.place !== null))
  if (!hasAnyOdds) return []

  return rows.sort((a, b) => (a.horse_no ?? 0) - (b.horse_no ?? 0))
}

function parseOdds(html: string) {
  const results: ParsedOddsRow[] = []
  const jsonCandidates: string[] = []
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = scriptRe.exec(html))) {
    const body = m[1] ?? ''
    if (body.includes('win') && body.includes('place') && body.length < 2_000_000) {
      jsonCandidates.push(body)
    }
  }

  for (const body of jsonCandidates) {
    const braceIdx = body.indexOf('{')
    const bracketIdx = body.indexOf('[')
    const start = braceIdx >= 0 && bracketIdx >= 0 ? Math.min(braceIdx, bracketIdx) : Math.max(braceIdx, bracketIdx)
    if (start < 0) continue

    const tail = body.slice(start)
    for (const endToken of ['</script>', ';\n', ';\r\n']) {
      const end = tail.indexOf(endToken)
      const snippet = end > 0 ? tail.slice(0, end) : tail
      try {
        const parsed = JSON.parse(snippet)
        const extracted = extractFromJson(parsed)
        if (extracted.length) return extracted
      } catch {
        // ignore
      }
    }
  }

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  while ((m = rowRe.exec(html))) {
    const rowHtml = m[1] ?? ''
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) =>
      stripTags(x[1] ?? '').trim()
    )
    if (cells.length < 6) continue

    const horseNo = safeInt(cells[0])
    const horseName = cells[1] ? cells[1] : null
    const withdrawn = cells.some((c) => c === '退出' || c.includes('退出'))
    const tailNums = cells
      .slice(-4)
      .map((c) => toNumberOrNull(c))
      .filter((n) => n !== null) as number[]

    if (!horseNo || !horseName) continue
    if (withdrawn) {
      results.push({
        horse_no: horseNo,
        horse_name: horseName,
        barrier: null,
        jockey_name: null,
        trainer_name: null,
        win: null,
        place: null,
        withdrawn: true
      })
      continue
    }
    if (tailNums.length < 2) continue
    results.push({
      horse_no: horseNo,
      horse_name: horseName,
      barrier: null,
      jockey_name: null,
      trainer_name: null,
      win: tailNums[tailNums.length - 2] ?? null,
      place: tailNums[tailNums.length - 1] ?? null
    })
  }

  return results
}

function extractFromJson(node: unknown) {
  const out: ParsedOddsRow[] = []

  const visit = (v: unknown) => {
    if (!v) return
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const horseNo =
      safeInt(o.horseNo ?? o.horse_no ?? o.horse_number ?? o.number ?? o.no ?? o.horseNumber) ??
      null
    const horseName = (o.horseName ?? o.horse_name ?? o.name ?? o.horse) as string | undefined
    const win = toNumberOrNull(o.win ?? o.winOdds ?? o.win_odds ?? o.w)
    const place = toNumberOrNull(o.place ?? o.placeOdds ?? o.place_odds ?? o.p)

    if ((horseNo !== null || horseName) && (win !== null || place !== null)) {
      out.push({
        horse_no: horseNo,
        horse_name: horseName ?? null,
        barrier: null,
        jockey_name: null,
        trainer_name: null,
        win,
        place
      })
    }

    for (const k of Object.keys(o)) visit(o[k])
  }

  visit(node)
  const byNo = new Map<number, (typeof out)[number]>()
  for (const r of out) {
    if (typeof r.horse_no === 'number') byNo.set(r.horse_no, r)
  }
  return byNo.size ? [...byNo.values()] : out
}

function stripTags(s: string) {
  return s.replaceAll(/<[^>]+>/g, ' ')
}

function toNumberOrNull(v: unknown) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim().replaceAll(/[,]/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
