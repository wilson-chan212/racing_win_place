// HKJC GraphQL — same allowlisted query shape as supabase/functions/extract-race-results

export const HKJC_GRAPHQL_URL = 'https://info.cld.hkjc.com/graphql/base/'

export const HKJC_RACE_MEETINGS_QUERY = `
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

function safeInt(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function normalizeHkjcMeetingDate(d) {
  if (d == null || d === '') return null
  const s = String(d).trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function getTodayHKDate() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const part = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Calendar YYYY-MM-DD in Hong Kong for an ISO post time (race day vs card date). */
function postTimeToCalendarDateHK(postTime) {
  if (postTime == null || postTime === '') return null
  const d = new Date(postTime)
  if (Number.isNaN(d.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d)
  const part = (type) => parts.find((p) => p.type === type)?.value ?? ''
  const y = part('year')
  const mo = part('month')
  const da = part('day')
  if (!y || !mo || !da) return null
  return `${y}-${mo}-${da}`
}

function totalRacesFromGraphqlMeeting(m) {
  const totalRaw = m?.totalNumberOfRace
  if (typeof totalRaw === 'number' && totalRaw >= 1) return Math.trunc(totalRaw)
  if (Number.isFinite(Number(totalRaw))) {
    const n = Math.trunc(Number(totalRaw))
    if (n >= 1) return n
  }
  const races = m?.races ?? []
  let maxNo = 0
  for (const r of races) {
    const n = safeInt(r?.no)
    if (n != null && n > maxNo) maxNo = n
  }
  return maxNo >= 1 ? maxNo : null
}

/**
 * Include a meeting only if some race actually runs on the punter's HK calendar day.
 * Drops simulcast / other cards (e.g. S1, S2) that HKJC still hangs off the same query date
 * but whose post times are not on `norm`.
 */
function meetingQualifiesForPunterSelectedDay(m, norm) {
  const races = m?.races ?? []
  for (const r of races) {
    if (postTimeToCalendarDateHK(r?.postTime) === norm) return true
  }
  return false
}

function countRacesOnSelectedHkDay(m, norm) {
  let n = 0
  for (const r of m?.races ?? []) {
    if (postTimeToCalendarDateHK(r?.postTime) === norm) n++
  }
  return n
}

function mapGraphqlMeetingToListRow(m, norm) {
  const d = normalizeHkjcMeetingDate(m?.date)
  const venueCode = String(m?.venueCode ?? '').trim()
  if (!venueCode) return null
  const countryCh = String(m?.country?.namech ?? '').trim()
  const countryEn = String(m?.country?.nameen ?? '').trim()
  const onDay = countRacesOnSelectedHkDay(m, norm)
  const fromApi = totalRacesFromGraphqlMeeting(m)
  /** Prefer HKJC card size; `onDay` can undercount if postTime calendar mapping misses races */
  const merged = Math.max(onDay, fromApi ?? 0)
  const totalNumberOfRace = merged >= 1 ? Math.min(99, merged) : null
  return {
    venueCode,
    date: d ?? norm,
    totalNumberOfRace,
    countryCh,
    countryEn
  }
}

function mergeMeetingsByVenue(norm, datedMeetings, activeMeetings) {
  const byVenue = new Map()
  for (const m of datedMeetings ?? []) {
    if (!meetingQualifiesForPunterSelectedDay(m, norm)) continue
    const row = mapGraphqlMeetingToListRow(m, norm)
    if (row) byVenue.set(row.venueCode, row)
  }
  for (const m of activeMeetings ?? []) {
    if (!meetingQualifiesForPunterSelectedDay(m, norm)) continue
    const row = mapGraphqlMeetingToListRow(m, norm)
    if (!row) continue
    const existing = byVenue.get(row.venueCode)
    if (!existing) {
      byVenue.set(row.venueCode, row)
      continue
    }
    const a = existing.totalNumberOfRace ?? 0
    const b = row.totalNumberOfRace ?? 0
    const chosen = b > a ? row : existing
    const merged = { ...chosen }
    const maxRaces = Math.max(a, b)
    if (maxRaces >= 1) merged.totalNumberOfRace = Math.min(99, maxRaces)
    if (!merged.countryCh && (existing.countryCh || row.countryCh)) {
      merged.countryCh = existing.countryCh || row.countryCh
    }
    if (!merged.countryEn && (existing.countryEn || row.countryEn)) {
      merged.countryEn = existing.countryEn || row.countryEn
    }
    byVenue.set(row.venueCode, merged)
  }
  const merged = [...byVenue.values()]
  return dropS1S2WhenDomesticHkPresent(merged).sort((a, b) =>
    a.venueCode.localeCompare(b.venueCode)
  )
}

/**
 * S1 / S2 are usually non–Sha Tin simulcast noise on the same HK calendar day as ST/HV.
 * Keep **S3** and other codes (e.g. extra pools) when local turf ST or HV is on the card.
 */
function dropS1S2WhenDomesticHkPresent(rows) {
  const list = rows ?? []
  const hasDomestic = list.some((r) => r.venueCode === 'ST' || r.venueCode === 'HV')
  if (!hasDomestic) return list
  return list.filter((r) => r.venueCode !== 'S1' && r.venueCode !== 'S2')
}

function meetingSortKey(meeting) {
  const date = normalizeHkjcMeetingDate(meeting?.date) ?? '9999-12-31'
  const firstPost = meeting?.races
    ?.map((race) => race?.postTime)
    .filter(Boolean)
    .sort()[0] ?? ''
  return `${date}T${firstPost}`
}

function pickNextRaceMeeting(meetings, todayHK = getTodayHKDate()) {
  return (meetings ?? [])
    .map((meeting) => ({
      ...meeting,
      date: normalizeHkjcMeetingDate(meeting?.date)
    }))
    .filter((meeting) => meeting.date && meeting.date >= todayHK)
    .sort((a, b) => meetingSortKey(a).localeCompare(meetingSortKey(b)))[0] ?? null
}

function formatPostTimeHK(postTime) {
  if (postTime == null || postTime === '') return ''
  const d = new Date(postTime)
  if (!Number.isNaN(d.getTime())) {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Hong_Kong'
    }).format(d)
  }
  const m = String(postTime).match(/(\d{1,2}):(\d{2})/)
  return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : String(postTime)
}

/**
 * @param {string} raceDate YYYY-MM-DD
 * @param {string} meetingCode e.g. S2
 * @param {number} raceNo
 * @returns {Promise<string>}
 */
export async function fetchRaceSubtitle(raceDate, meetingCode, raceNo) {
  const res = await fetch(HKJC_GRAPHQL_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; ProjectRace/1.0)'
    },
    body: JSON.stringify({
      query: HKJC_RACE_MEETINGS_QUERY,
      variables: { date: raceDate, venueCode: meetingCode }
    })
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const body = await res.json()
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? 'GraphQL error').join('; '))
  }

  const meeting = body?.data?.raceMeetings?.[0]
  if (!meeting) {
    return `第${raceNo}場 · ${raceDate} · 會場 ${meetingCode}（未有賽事資料）`
  }

  const apiDateNorm = normalizeHkjcMeetingDate(meeting.date)
  if (!apiDateNorm) {
    return `無法取得馬會賽事日（${meetingCode} · ${raceDate}）`
  }
  // HKJC `meeting.date` can differ from the WP calendar date the punter uses (e.g. card vs session).
  // Do not block subtitle when the API already returned this meeting for `raceDate`.

  const races = meeting?.races ?? []
  const race = races.find((r) => safeInt(r.no) === raceNo)

  if (!race) {
    return `第${raceNo}場 · ${raceDate} · 會場 ${meetingCode}（未有賽事資料）`
  }

  const timeStr = formatPostTimeHK(race.postTime)
  const track = race.raceTrack?.description_ch || race.raceTrack?.description_en || ''
  const country = race.country_ch || race.country_en || ''
  const going = race.go_ch || race.go_en || ''
  const dist =
    race.distance != null && race.distance !== ''
      ? `${race.distance}米`
      : ''

  const parts = [timeStr, track, country, going, dist].filter(Boolean)
  const base = parts.length ? parts.join(', ') : `第${raceNo}場`
  const name = race.raceName_ch || race.raceName_en
  return name ? `${name} · ${base}` : base
}

/**
 * Meetings for a calendar day, merged from dated + active GraphQL lists.
 * Only includes a venue if at least one race has postTime on `raceDate` in Asia/Hong_Kong.
 * When **ST** or **HV** is present, **S1** and **S2** rows are removed (common simulcast noise).
 * **S3** and other venue codes stay so you can still pick them alongside 沙田.
 * `meeting.date` may still differ from the URL day; post times are the source of truth here.
 *
 * @param {string} raceDate YYYY-MM-DD
 * @returns {Promise<Array<{ venueCode: string, date: string, totalNumberOfRace: number | null, countryCh: string, countryEn: string }>>}
 */
export async function fetchMeetingsForCalendarDate(raceDate) {
  const norm = normalizeHkjcMeetingDate(raceDate)
  if (!norm) return []

  const res = await fetch(HKJC_GRAPHQL_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; ProjectRace/1.0)'
    },
    body: JSON.stringify({
      query: HKJC_RACE_MEETINGS_QUERY,
      variables: { date: norm, venueCode: null }
    })
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const body = await res.json()
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? 'GraphQL error').join('; '))
  }

  const list = body?.data?.raceMeetings
  if (!Array.isArray(list)) return []

  const active = body?.data?.activeMeetings
  const activeList = Array.isArray(active) ? active : []

  return mergeMeetingsByVenue(norm, list, activeList)
}

/** Betting WP URL segment matches HKJC web (`/ch/` or `/en/`). */
export function buildHkjcWpOddsUrl(locale, raceDate, meetingCode, raceNo) {
  const loc = locale === 'en' ? 'en' : 'ch'
  const dateNorm = normalizeHkjcMeetingDate(raceDate) ?? String(raceDate).trim()
  const code = String(meetingCode ?? '').trim()
  const n = typeof raceNo === 'number' ? raceNo : Number(raceNo)
  const no = Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1
  return `https://bet.hkjc.com/${loc}/racing/wp/${dateNorm}/${encodeURIComponent(code)}/${no}`
}

/**
 * Returns the next HKJC racing day from the official active meeting calendar.
 * @returns {Promise<{ date: string, venueCode: string } | null>}
 */
export async function fetchNextRaceMeeting() {
  const todayHK = getTodayHKDate()
  const res = await fetch(HKJC_GRAPHQL_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; ProjectRace/1.0)'
    },
    body: JSON.stringify({
      query: HKJC_RACE_MEETINGS_QUERY,
      variables: { date: todayHK, venueCode: null }
    })
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const body = await res.json()
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? 'GraphQL error').join('; '))
  }

  const meeting = pickNextRaceMeeting(body?.data?.activeMeetings, todayHK)
    ?? pickNextRaceMeeting(body?.data?.raceMeetings, todayHK)
  if (!meeting) return null

  return {
    date: meeting.date,
    venueCode: meeting.venueCode ?? ''
  }
}
