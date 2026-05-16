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
    const w = toNumberOrNull(runner.winOdds)
    if (w === null) continue
    const current = ensureRow(no)
    if (current.win === null) current.win = w
    byHorseNo.set(no, current)
  }

  const rows = [...byHorseNo.values()].filter(
    (r) => r.withdrawn || r.win !== null || r.place !== null
  )
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
