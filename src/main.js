import './style.css'
import { runWithSiteGate } from './lib/siteGate.js'
import { assertSupabaseConfigured, supabase } from './lib/supabase.js'
import {
  buildHkjcWpOddsUrl,
  fetchMeetingsForCalendarDate,
  fetchRaceSubtitle
} from './lib/hkjcRaceMeta.js'

const HK_TZ = 'Asia/Hong_Kong'

function hongKongDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function hkDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

/** `datetime-local` value interpreted as Hong Kong wall time (UTC+8, no DST). */
function toDateTimeLocalValueHK(date = new Date()) {
  const p = hkDateTimeParts(date)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

function parseHKDateTimeLocalToISO(value) {
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!m) throw new Error('請填寫正確的預定時間')
  const isoLocal = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`
  const date = new Date(isoLocal)
  if (Number.isNaN(date.getTime())) throw new Error('請填寫正確的預定時間')
  return date.toISOString()
}

function formatDateTimeHK(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const p = hkDateTimeParts(date)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

function formatMonthDayHmHK(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const p = hkDateTimeParts(date)
  return `${Number(p.month)}月${Number(p.day)} ${p.hour}:${p.minute}`
}

const state = {
  賽事: {
    subtitle: '載入中…'
  },
  篩選: {
    /** Same calendar day can host multiple HKJC meetings (e.g. S1 / S2 → …/wp/日期/S1/1） */
    賽馬日: hongKongDateInputValue(),
    會場代號: 'S1',
    場次編號: '1'
  },
  ui: {
    /** 'live' | 'scheduled' — which bottom-tab panel is shown */
    bottomTab: 'live',
    /** Meetings returned by HKJC GraphQL for `state.篩選.賽馬日` */
    dayMeetings: [],
    meetingsLoading: false,
    /** Hide withdrawn (退出) horses in 即時賠率 + 預定抄賠率 results table */
    hideWithdrawnHorses: false,
    /** Hide the first (left-most) column in tables */
    hideFirstColumn: false,
    /** Hide finished 預約提取 rows (completed / failed / cancelled) */
    hideCompletedJobs: false,
    /** Tap table cells to apply fixed light-yellow highlight */
    highlighterMode: false,
    /** Current highlight color id */
    highlighterColor: 'yellow',
    /** Freehand drawing on 預定抄賠率 panel */
    noteMode: false,
    /** Current note pen color id */
    noteColor: 'red',
    /** 'pen' | 'eraser' */
    noteTool: 'pen',
    /** Array of strokes, each stroke = [{x,y}, ...] in CSS px relative to canvas */
    noteStrokes: []
  },
  scheduled: {
    draftTimes: [toDateTimeLocalValueHK(new Date(Date.now() + 5 * 60 * 1000))],
    /** Race numbers (1-based) that receive new 預定 jobs on save — multi-select */
    targetRaceNos: [],
    /** Race number (1-based) shown in 預定抄賠率 results table — single select */
    viewRaceNo: null,
    /** Race number (1-based) for 預約提取 job list — single select */
    viewJobsRaceNo: null,
    jobs: [],
    snapshots: [],
    /** Per-race metadata (e.g. speed map URL) for current meeting day */
    raceMetadata: [],
    /** User-entered win/place odds per horse — keys from manualOddsKey() */
    manualOdds: {},
    loading: false,
    loadedKey: ''
  }
}

let rows = []
let scheduleDuePollTimer = null
let hideWithdrawnClickDelegationAbort = null
let highlighterClickDelegationAbort = null
let noteCanvasAbort = null

const HIGHLIGHT_STORAGE_KEY = 'projectRace_cellHighlights'
const HIGHLIGHT_COLOR_STORAGE_KEY = 'projectRace_highlighterColor'
/** Remember 即時／預定 tab so reload keeps the same Supabase-backed view. */
const BOTTOM_TAB_STORAGE_KEY = 'projectRace_bottomTab'
const HIDE_FIRST_COL_STORAGE_KEY = 'projectRace_hideFirstColumn'
const HIDE_COMPLETED_JOBS_STORAGE_KEY = 'projectRace_hideCompletedJobs'
const MANUAL_ODDS_STORAGE_KEY = 'projectRace_manualOdds'

const HIGHLIGHT_COLORS = [
  { id: 'yellow', label: '黃', css: '#fff59a' },
  { id: 'pink', label: '粉紅', css: '#ffd1e8' },
  { id: 'green', label: '綠', css: '#c8f7c5' }
]

const NOTE_COLORS = [
  { id: 'red', label: '紅', css: '#ef4444' },
  { id: 'blue', label: '藍', css: '#2563eb' },
  { id: 'purple', label: '紫', css: '#7c3aed' }
]

function persistHideFirstColumn() {
  try {
    localStorage.setItem(HIDE_FIRST_COL_STORAGE_KEY, state.ui.hideFirstColumn ? '1' : '0')
  } catch {
    // ignore quota / privacy mode
  }
}

function restoreHideFirstColumnFromStorage() {
  try {
    const v = localStorage.getItem(HIDE_FIRST_COL_STORAGE_KEY)
    state.ui.hideFirstColumn = v === '1'
  } catch {
    /* ignore */
  }
}

function persistHideCompletedJobs() {
  try {
    localStorage.setItem(HIDE_COMPLETED_JOBS_STORAGE_KEY, state.ui.hideCompletedJobs ? '1' : '0')
  } catch {
    // ignore quota / privacy mode
  }
}

function restoreHideCompletedJobsFromStorage() {
  try {
    const v = localStorage.getItem(HIDE_COMPLETED_JOBS_STORAGE_KEY)
    state.ui.hideCompletedJobs = v === '1'
  } catch {
    /* ignore */
  }
}

function getHighlightsByKey() {
  if (!getHighlightsByKey._cache) {
    try {
      const raw = localStorage.getItem(HIGHLIGHT_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : null

      // Back-compat: v1 stored as string[]
      if (Array.isArray(parsed)) {
        const obj = Object.create(null)
        for (const k of parsed) {
          if (typeof k === 'string' && k) obj[k] = 'yellow'
        }
        getHighlightsByKey._cache = obj
        localStorage.setItem(HIGHLIGHT_STORAGE_KEY, JSON.stringify(obj))
      } else if (parsed && typeof parsed === 'object') {
        const obj = Object.create(null)
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k !== 'string' || !k) continue
          if (typeof v !== 'string' || !HIGHLIGHT_COLORS.some((c) => c.id === v)) continue
          obj[k] = v
        }
        getHighlightsByKey._cache = obj
      } else {
        getHighlightsByKey._cache = Object.create(null)
      }
    } catch {
      getHighlightsByKey._cache = Object.create(null)
    }
  }
  return getHighlightsByKey._cache
}

function persistHighlightsByKey() {
  localStorage.setItem(HIGHLIGHT_STORAGE_KEY, JSON.stringify(getHighlightsByKey()))
}

function getCellHighlightColor(key) {
  return getHighlightsByKey()[key] ?? null
}

function isCellHighlighted(key) {
  return Boolean(getCellHighlightColor(key))
}

function setCellHighlight(key, colorId) {
  if (!key) return
  const ok = HIGHLIGHT_COLORS.some((c) => c.id === colorId)
  if (!ok) return
  getHighlightsByKey()[key] = colorId
  persistHighlightsByKey()
}

function removeCellHighlight(key) {
  const map = getHighlightsByKey()
  if (map[key] == null) return
  delete map[key]
  persistHighlightsByKey()
}

function toggleCellHighlight(key, colorId) {
  const cur = getCellHighlightColor(key)
  if (cur && cur === colorId) removeCellHighlight(key)
  else setCellHighlight(key, colorId)
}

function liveHighlightKey(horseNo, column) {
  return `live|${state.篩選.賽馬日}|${state.篩選.會場代號}|${state.篩選.場次編號}|${horseNo}|${column}`
}

function liveHeaderHighlightKey(column) {
  return `live|${state.篩選.賽馬日}|${state.篩選.會場代號}|${state.篩選.場次編號}|hdr|${column}`
}

function scheduledHeaderHighlightKey(raceNo, horseNo) {
  return `sch|${state.篩選.賽馬日}|${state.篩選.會場代號}|${raceNo}|hdr|${horseNo}`
}

function scheduledMetaHighlightKey(raceNo, horseNo, column) {
  return `sch|${state.篩選.賽馬日}|${state.篩選.會場代號}|${raceNo}|meta|${horseNo}|${column}`
}

function scheduledOddsHighlightKey(raceNo, jobId, horseNo, field) {
  return `sch|${state.篩選.賽馬日}|${state.篩選.會場代號}|${raceNo}|odds|${jobId}|${horseNo}|${field}`
}

function scheduledManualOddsHighlightKey(raceNo, horseNo, field) {
  return `sch|${state.篩選.賽馬日}|${state.篩選.會場代號}|${raceNo}|manual|${horseNo}|${field}`
}

function manualOddsKey(raceNo, horseNo, field) {
  return `${state.篩選.賽馬日}|${state.篩選.會場代號}|${raceNo}|${horseNo}|${field}`
}

function getManualOddsValue(raceNo, horseNo, field) {
  return state.scheduled.manualOdds[manualOddsKey(raceNo, horseNo, field)] ?? ''
}

function setManualOddsValue(raceNo, horseNo, field, value) {
  const key = manualOddsKey(raceNo, horseNo, field)
  const trimmed = String(value ?? '').trim()
  if (trimmed) state.scheduled.manualOdds[key] = trimmed
  else delete state.scheduled.manualOdds[key]
  persistManualOdds()
}

function persistManualOdds() {
  try {
    localStorage.setItem(MANUAL_ODDS_STORAGE_KEY, JSON.stringify(state.scheduled.manualOdds))
  } catch {
    // ignore quota / privacy mode
  }
}

function restoreManualOddsFromStorage() {
  try {
    const raw = localStorage.getItem(MANUAL_ODDS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state.scheduled.manualOdds = parsed
    }
  } catch {
    /* ignore */
  }
}

function highlightCellClassSuffix(key) {
  const color = getCellHighlightColor(key)
  return color ? ` isHighlighted hl-${color}` : ''
}

function highlightDataAttr(key) {
  return ` data-highlight-key="${escapeHtml(key)}"`
}

function highlightTd(classNames, key, content) {
  return `<td class="${classNames}${highlightCellClassSuffix(key)}"${highlightDataAttr(key)}>${content}</td>`
}

function highlightTh(classNames, key, content) {
  return `<th class="${classNames}${highlightCellClassSuffix(key)}"${highlightDataAttr(key)}>${content}</th>`
}

function liveOddsTableHeadRow() {
  const cols = [
    ['場次', 'race', ''],
    ['馬號', 'no', ''],
    ['馬名', 'name', 'colTextCenter'],
    ['檔位', 'barrier', ''],
    ['騎師', 'jockey', 'colTextCenter'],
    ['練馬師', 'trainer', 'colTextCenter'],
    ['獨贏', 'win', ''],
    ['位置', 'place', '']
  ]
  return `<tr>${cols
    .map(([label, col, cls]) => highlightTh(cls, liveHeaderHighlightKey(col), escapeHtml(label)))
    .join('')}</tr>`
}

function persistBottomTab(which) {
  if (which !== 'live' && which !== 'scheduled') return
  try {
    localStorage.setItem(BOTTOM_TAB_STORAGE_KEY, which)
  } catch {
    // ignore quota / privacy mode
  }
}

/** Restore tab before first paint (jobs/results load in mount after Supabase gates). */
function restoreBottomTabFromStorage() {
  try {
    const v = localStorage.getItem(BOTTOM_TAB_STORAGE_KEY)
    if (v === 'scheduled' || v === 'live') state.ui.bottomTab = v
  } catch {
    /* ignore */
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function appBarRaceTitle() {
  return state.ui.bottomTab === 'scheduled' ? '預定抄賠率' : '即時賠率'
}

function syncAppBarHeadline() {
  const titleEl = document.querySelector('#raceTitle')
  const subEl = document.querySelector('#raceSub')
  if (titleEl) titleEl.textContent = appBarRaceTitle()
  if (subEl) subEl.textContent = state.賽事.subtitle ?? ''
}

function meetingOptionLabel(m) {
  const venueHints = { ST: '沙田', HV: '跑馬地' }
  const place = m.countryCh || m.countryEn || venueHints[m.venueCode] || '馬會'
  const races =
    m.totalNumberOfRace != null && m.totalNumberOfRace >= 1
      ? `共 ${m.totalNumberOfRace} 場`
      : '場次待定'
  return `${m.venueCode} · ${place} · ${races}`
}

function hideWithdrawnToggleButtonHtml() {
  const on = state.ui.hideWithdrawnHorses
  return `<button type="button" class="ghostBtn toggleHideWithdrawnBtn" aria-pressed="${on ? 'true' : 'false'}">${on ? '顯示退出馬匹' : '隱藏退出馬匹'}</button>`
}

function hideFirstColumnToggleButtonHtml() {
  const on = state.ui.hideFirstColumn
  return `<button type="button" class="ghostBtn toggleHideFirstColBtn" aria-pressed="${on ? 'true' : 'false'}">${on ? '顯示左欄' : '隱藏左欄'}</button>`
}

function hideCompletedJobsToggleButtonHtml() {
  const on = state.ui.hideCompletedJobs
  return `<button type="button" class="ghostBtn toggleHideCompletedJobsBtn" aria-pressed="${on ? 'true' : 'false'}">${on ? '顯示已完成項目' : '隱藏已完成項目'}</button>`
}

function isFinishedScheduleJob(job) {
  return ['completed', 'failed', 'cancelled'].includes(job.status)
}

function highlighterToolHtml() {
  const on = state.ui.highlighterMode
  const cur = state.ui.highlighterColor
  return `
    <div class="hlToolGroup${on ? ' isOpen' : ''}">
      <button type="button" class="ghostBtn toggleHighlighterBtn" aria-pressed="${on ? 'true' : 'false'}">${on ? '關閉熒光筆' : '熒光筆'}</button>
      <div class="hlColorRow" role="radiogroup" aria-label="熒光筆顏色" aria-hidden="${on ? 'false' : 'true'}">
        ${HIGHLIGHT_COLORS.map((c) => {
          const active = c.id === cur ? ' isActive' : ''
          return `<button type="button" class="hlColorBtn${active}" data-hl-color="${escapeHtml(c.id)}" aria-pressed="${c.id === cur ? 'true' : 'false'}" title="${escapeHtml(c.label)}" tabindex="${on ? '0' : '-1'}">
            <span class="hlSwatch" style="--swatch:${escapeHtml(c.css)}"></span>
          </button>`
        }).join('')}
      </div>
    </div>
  `
}

function noteToolHtml() {
  const on = state.ui.noteMode
  const cur = state.ui.noteColor
  return `
    <div class="noteToolGroup${on ? ' isOpen' : ''}">
      <button type="button" class="ghostBtn toggleNoteBtn" aria-pressed="${on ? 'true' : 'false'}">${on ? '關閉筆記' : '筆記'}</button>
      <div class="noteColorRow" role="radiogroup" aria-label="筆記顏色" aria-hidden="${on ? 'false' : 'true'}">
        ${NOTE_COLORS.map((c) => {
          const active = c.id === cur ? ' isActive' : ''
          return `<button type="button" class="noteColorBtn${active}" data-note-color="${escapeHtml(c.id)}" aria-pressed="${c.id === cur ? 'true' : 'false'}" title="${escapeHtml(c.label)}" tabindex="${on ? '0' : '-1'}">
            <span class="noteSwatch" style="--swatch:${escapeHtml(c.css)}"></span>
          </button>`
        }).join('')}
      </div>
    </div>
  `
}

function noteClearButtonHtml() {
  const on = state.ui.noteMode
  const hidden = on ? '' : ' hidden aria-hidden="true"'
  return `<button type="button" class="ghostBtn clearNoteBtn"${hidden}>清除筆記</button>`
}

function noteEraserToggleButtonHtml() {
  const on = state.ui.noteMode
  const isEraser = state.ui.noteTool === 'eraser'
  const hidden = on ? '' : ' hidden aria-hidden="true"'
  return `<button type="button" class="ghostBtn toggleEraserBtn${isEraser ? ' isActive' : ''}" aria-pressed="${isEraser ? 'true' : 'false'}"${hidden}>橡皮擦</button>`
}

function hkjcWpAndHideRowFragment(linkId) {
  const href = buildHkjcWpOddsUrl('ch', state.篩選.賽馬日, state.篩選.會場代號, state.篩選.場次編號)
  const noteControls =
    state.ui.bottomTab === 'scheduled'
      ? `${noteToolHtml()}${noteClearButtonHtml()}${noteEraserToggleButtonHtml()}`
      : ''
  return `
        <a
          id="${linkId}"
          class="hkjcWpLink"
          href="${escapeHtml(href)}"
          target="_blank"
          rel="noopener noreferrer"
        >開啟馬會投注頁（對應目前選項）</a>
        ${noteControls}
        ${highlighterToolHtml()}
        ${hideFirstColumnToggleButtonHtml()}
        ${hideWithdrawnToggleButtonHtml()}
  `
}

function meetingRaceCap() {
  const meeting = state.ui.dayMeetings.find((m) => m.venueCode === state.篩選.會場代號)
  if (!meeting) return 0
  const max = meeting.totalNumberOfRace
  if (max == null || max < 1) return 0
  return Math.min(99, max)
}

function formatRaceNosLabel(nums) {
  if (!nums?.length) return ''
  return `第${nums.join('、')}場`
}

/** Keep scheduled multi-select race list valid for current meeting / 場次上限 */
function syncScheduledTargetRacesForMeeting() {
  const cap = meetingRaceCap()
  if (cap < 1) {
    state.scheduled.targetRaceNos = []
    return
  }
  const r0 = Number(state.篩選.場次編號)
  const base = Number.isFinite(r0) && r0 >= 1 && r0 <= cap ? r0 : Math.min(1, cap)
  const prev = Array.isArray(state.scheduled.targetRaceNos) ? state.scheduled.targetRaceNos : []
  let arr = prev.filter((n) => Number.isInteger(n) && n >= 1 && n <= cap)
  if (!arr.length) arr = [base]
  state.scheduled.targetRaceNos = [...new Set(arr)].sort((a, b) => a - b)
}

/** Which race to show in 預定抄賠率 results (defaults to first race with jobs) */
function syncScheduledViewRaceForMeeting() {
  const cap = meetingRaceCap()
  if (cap < 1) {
    state.scheduled.viewRaceNo = null
    return
  }
  let n = Number(state.scheduled.viewRaceNo)
  if (!Number.isInteger(n) || n < 1 || n > cap) {
    const fromJobs = [
      ...new Set(
        state.scheduled.jobs
          .map((j) => j.race_no)
          .filter((r) => Number.isInteger(r) && r >= 1 && r <= cap)
      )
    ].sort((a, b) => a - b)
    if (fromJobs.length) n = fromJobs[0]
    else if (state.scheduled.targetRaceNos.length) n = state.scheduled.targetRaceNos[0]
    else {
      const r0 = Number(state.篩選.場次編號)
      n = Number.isFinite(r0) && r0 >= 1 && r0 <= cap ? r0 : Math.min(1, cap)
    }
  }
  state.scheduled.viewRaceNo = Math.trunc(n)
}

/** Which race to show in 預約提取 job list (defaults to first race with jobs) */
function syncScheduledViewJobsRaceForMeeting() {
  const cap = meetingRaceCap()
  if (cap < 1) {
    state.scheduled.viewJobsRaceNo = null
    return
  }
  let n = Number(state.scheduled.viewJobsRaceNo)
  if (!Number.isInteger(n) || n < 1 || n > cap) {
    const fromJobs = [
      ...new Set(
        state.scheduled.jobs
          .map((j) => j.race_no)
          .filter((r) => Number.isInteger(r) && r >= 1 && r <= cap)
      )
    ].sort((a, b) => a - b)
    if (fromJobs.length) n = fromJobs[0]
    else if (state.scheduled.targetRaceNos.length) n = state.scheduled.targetRaceNos[0]
    else {
      const r0 = Number(state.篩選.場次編號)
      n = Number.isFinite(r0) && r0 >= 1 && r0 <= cap ? r0 : Math.min(1, cap)
    }
  }
  state.scheduled.viewJobsRaceNo = Math.trunc(n)
}

function scheduleRaceQuickPickTemplate() {
  const cur = state.篩選.會場代號
  const meeting = state.ui.dayMeetings.find((m) => m.venueCode === cur)
  const max = meeting?.totalNumberOfRace
  if (max == null || max < 1) return ''
  const safeMax = Math.min(99, max)
  const selected = new Set(state.scheduled.targetRaceNos)
  const buttons = []
  for (let r = 1; r <= safeMax; r++) {
    const isOn = selected.has(r)
    const active = isOn ? ' scheduleRacePickActive' : ''
    buttons.push(
      `<button type="button" class="ghostBtn scheduleRacePick${active}" data-race-no="${r}" aria-pressed="${isOn ? 'true' : 'false'}">第${r}場</button>`
    )
  }
  return `<div class="scheduleRacePickRow" role="group" aria-label="複選預定場次">${buttons.join('')}</div>`
}

/** Rebuild 複選預定場次 chips when 會場 / 賽馬日 changes without full mount */
function renderScheduleRacePickInDom() {
  const host = document.querySelector('#controlsRowRaceMulti')
  if (!host || !supabase) return
  syncScheduledTargetRacesForMeeting()
  host.innerHTML = `<span class="schedulePickBarLabel">複選預定場次（儲存預定時間時套用）</span>
    ${scheduleRaceQuickPickTemplate()}`
  bindScheduleRacePickButtons()
}

function scheduleViewRacePickTemplate() {
  const cap = meetingRaceCap()
  if (cap < 1) return ''
  const selectedNo = state.scheduled.viewRaceNo
  const buttons = []
  for (let r = 1; r <= cap; r++) {
    const isOn = r === selectedNo
    const active = isOn ? ' scheduleRacePickActive' : ''
    buttons.push(
      `<button type="button" class="ghostBtn scheduleViewRacePick${active}" data-race-no="${r}" aria-pressed="${isOn ? 'true' : 'false'}">第${r}場</button>`
    )
  }
  return `<div class="scheduleRacePickRow" role="radiogroup" aria-label="檢視場次（單選）">${buttons.join('')}</div>`
}

function updateScheduleViewRacePickButtonsInDom() {
  const selectedNo = state.scheduled.viewRaceNo
  document.querySelectorAll('.scheduleViewRacePick').forEach((btn) => {
    const r = Number(btn.dataset.raceNo)
    const isOn = r === selectedNo
    btn.classList.toggle('scheduleRacePickActive', isOn)
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false')
  })
}

function renderScheduleViewRacePickInDom() {
  const host = document.querySelector('#scheduleViewRacePickHost')
  if (!host) return
  syncScheduledViewRaceForMeeting()
  host.innerHTML = scheduleViewRacePickTemplate()
  bindScheduleViewRacePickButtons()
}

function scheduledViewJobsRacePickSection() {
  if (meetingRaceCap() < 1) return ''
  return `
      <div class="scheduledViewJobsRaceBlock scheduleRacePickBar">
        <span class="schedulePickBarLabel">檢視場次（預約提取）</span>
        <div id="scheduleViewJobsRacePickHost" class="scheduleRacePickRowWrap">${scheduleViewJobsRacePickTemplate()}</div>
        ${hideCompletedJobsToggleButtonHtml()}
      </div>`
}

function scheduledViewRacePickSection() {
  if (meetingRaceCap() < 1) return ''
  return `
      <div class="scheduledViewRaceBlock scheduleRacePickBar">
        <span class="schedulePickBarLabel">檢視場次（結果表格）</span>
        <div id="scheduleViewRacePickHost" class="scheduleRacePickRowWrap">${scheduleViewRacePickTemplate()}</div>
      </div>`
}

function scheduleViewJobsRacePickTemplate() {
  const cap = meetingRaceCap()
  if (cap < 1) return ''
  const selectedNo = state.scheduled.viewJobsRaceNo
  const buttons = []
  for (let r = 1; r <= cap; r++) {
    const isOn = r === selectedNo
    const active = isOn ? ' scheduleRacePickActive' : ''
    buttons.push(
      `<button type="button" class="ghostBtn scheduleViewJobsRacePick${active}" data-race-no="${r}" aria-pressed="${isOn ? 'true' : 'false'}">第${r}場</button>`
    )
  }
  return `<div class="scheduleRacePickRow" role="radiogroup" aria-label="檢視場次（預約提取）">${buttons.join('')}</div>`
}

function updateScheduleViewJobsRacePickButtonsInDom() {
  const selectedNo = state.scheduled.viewJobsRaceNo
  document.querySelectorAll('.scheduleViewJobsRacePick').forEach((btn) => {
    const r = Number(btn.dataset.raceNo)
    const isOn = r === selectedNo
    btn.classList.toggle('scheduleRacePickActive', isOn)
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false')
  })
}

function renderScheduleViewJobsRacePickInDom() {
  const host = document.querySelector('#scheduleViewJobsRacePickHost')
  if (!host) return
  syncScheduledViewJobsRaceForMeeting()
  host.innerHTML = scheduleViewJobsRacePickTemplate()
  bindScheduleViewJobsRacePickButtons()
  if (typeof redrawNoteCanvas === 'function') redrawNoteCanvas()
}

function renderScheduleJobsListInDom() {
  const host = document.querySelector('#scheduleJobsHost')
  if (!host) return
  host.innerHTML = scheduleJobsTemplate(state.scheduled.jobs)
  bindScheduleJobListActions()
  if (typeof redrawNoteCanvas === 'function') redrawNoteCanvas()
}

function visibleLiveRows() {
  return state.ui.hideWithdrawnHorses ? rows.filter((r) => !r.withdrawn) : rows
}

function meetingSelectTemplate() {
  const loading = state.ui.meetingsLoading
  const list = state.ui.dayMeetings
  const cur = state.篩選.會場代號

  if (loading) {
    return `<select id="meetingSelect" class="controlSelect" disabled aria-busy="true" aria-label="會場">
      <option value="${escapeHtml(cur)}">${escapeHtml(`${cur} · 載入會場列表…`)}</option>
    </select>`
  }

  if (!list.length) {
    return `<select id="meetingSelect" class="controlSelect" aria-label="會場">
      <option value="${escapeHtml(cur)}">${escapeHtml(`${cur}（無列表 — 請確認賽馬日或網絡）`)}</option>
    </select>`
  }

  const opts = list
    .map((m) => {
      const sel = m.venueCode === cur ? ' selected' : ''
      return `<option value="${escapeHtml(m.venueCode)}"${sel}>${escapeHtml(meetingOptionLabel(m))}</option>`
    })
    .join('')
  return `<select id="meetingSelect" class="controlSelect" aria-label="會場">${opts}</select>`
}

function appTemplate() {
  if (supabase) syncScheduledTargetRacesForMeeting()
  const configured = Boolean(supabase)
  const liveActive = state.ui.bottomTab === 'live'
  const scheduledActive = state.ui.bottomTab === 'scheduled'
  return `
  <div class="appShell">
    <header class="appBar">
      <div class="appBarCenter">
        <div class="appBarHeadline">
          <div class="raceTitle" id="raceTitle">${appBarRaceTitle()}</div>
          <p class="raceSub" id="raceSub">${escapeHtml(state.賽事.subtitle)}</p>
        </div>
      </div>
      <button class="iconBtn" type="button" aria-label="從馬會更新賽事列表並提取賠率" id="btnRefresh">⟳</button>
    </header>

    <section class="controls">
      <div class="controlsRow controlsRowFiltersBar" id="controlsRowFiltersBar">
        <label class="field fieldInline fieldGrow controlsFieldDate">
          <span class="fieldLabel fieldLabelInline">賽馬日</span>
          <input id="raceDate" type="date" value="${state.篩選.賽馬日}" />
        </label>
        <label class="field fieldInline fieldGrow controlsFieldMeeting">
          <span class="fieldLabel fieldLabelInline">會場</span>
          ${meetingSelectTemplate()}
        </label>
        <div class="field fieldInline fieldRaceNo controlsFieldRaceNo" id="controlsFieldRaceNo">
          <span class="fieldLabel fieldLabelInline">場次</span>
          <div class="raceNoStepper" role="group" aria-label="場次">
            <button type="button" class="stepperBtn" id="btnRaceNoDown" aria-label="上一場">−</button>
            <input id="raceNo" type="number" min="1" max="99" step="1" value="${state.篩選.場次編號}" />
            <button type="button" class="stepperBtn" id="btnRaceNoUp" aria-label="下一場">+</button>
          </div>
        </div>
      </div>
      ${
        configured
          ? `<div class="controlsRow controlsRowRaceMulti scheduleRacePickBar" id="controlsRowRaceMulti" ${scheduledActive ? '' : 'hidden'}>
        <span class="schedulePickBarLabel">複選預定場次（儲存預定時間時套用）</span>
        ${scheduleRaceQuickPickTemplate()}
      </div>`
          : ''
      }
      ${configured ? '' : `<div class="hint">未設定 Supabase（請複製 <code>.env.example</code> 為 <code>.env</code> 並填入金鑰）</div>`}
    </section>

    <div class="bodyWithBottomTabs">
      <div class="tabPanels">
        <div
          id="panelLive"
          class="tabPanel"
          role="tabpanel"
          aria-labelledby="tabLiveBtn"
          ${liveActive ? '' : 'hidden'}
        >
          <div class="oddsTableWrap" role="region" aria-label="即時賠率表">
            <table class="oddsTable">
              <thead>
                ${liveOddsTableHeadRow()}
              </thead>
              <tbody>
                ${visibleLiveRows().map((row) => rowTemplate(row)).join('')}
              </tbody>
            </table>
          </div>
          ${
            configured
              ? `<div class="liveFooterBar"><div class="liveHkjcRow">${hkjcWpAndHideRowFragment('linkHkjcWp')}</div></div>`
              : ''
          }
        </div>

        <div
          id="panelScheduled"
          class="tabPanel"
          role="tabpanel"
          aria-labelledby="tabScheduledBtn"
          ${scheduledActive ? '' : 'hidden'}
        >
          ${scheduledTemplate()}
        </div>
      </div>

      <nav class="bottomNav" role="tablist" aria-label="賠率分頁">
        <button
          type="button"
          role="tab"
          id="tabLiveBtn"
          class="bottomNavBtn${liveActive ? ' isActive' : ''}"
          aria-selected="${liveActive ? 'true' : 'false'}"
          aria-controls="panelLive"
        >即時賠率</button>
        <button
          type="button"
          role="tab"
          id="tabScheduledBtn"
          class="bottomNavBtn${scheduledActive ? ' isActive' : ''}"
          aria-selected="${scheduledActive ? 'true' : 'false'}"
          aria-controls="panelScheduled"
        >預定抄賠率</button>
      </nav>
    </div>

    <div class="snackbar" id="snackbar" aria-live="polite" aria-atomic="true"></div>
  </div>
  `
}

function scheduledTemplate() {
  if (!supabase) {
    return `<div class="blankScheduled" aria-label="預定抄賠率（未設定 Supabase）"></div>`
  }

  syncScheduledTargetRacesForMeeting()
  syncScheduledViewRaceForMeeting()
  syncScheduledViewJobsRaceForMeeting()
  const jobs = state.scheduled.jobs
  const pendingCount = jobs.filter((job) => job.status === 'pending').length
  const completedCount = jobs.filter((job) => job.status === 'completed').length

  return `
    <section class="scheduledPanel noteHost" aria-label="預定抄賠率">
      <div class="scheduledCard">
        <div class="scheduleActions">
          <button type="button" class="ghostBtn" id="btnAddScheduleTime">新增時間</button>
          <button type="button" class="primaryBtn" id="btnSaveScheduleTimes">儲存預定時間</button>
        </div>

        <div class="scheduleDraftList" aria-label="預定提取時間">
          ${state.scheduled.draftTimes.map((time, index) => scheduleTimeInputTemplate(time, index)).join('')}
        </div>
      </div>

      <div class="scheduledFooterBar">
        <div class="scheduledSummary">
          <span>待提取 ${pendingCount}</span>
          <span>已完成 ${completedCount}</span>
          ${state.scheduled.loading ? '<span>載入中…</span>' : ''}
        </div>
        <div class="scheduledHkjcRow">${hkjcWpAndHideRowFragment('linkHkjcWpScheduled')}</div>
      </div>

      ${scheduledViewJobsRacePickSection()}
      <div id="scheduleJobsHost">${scheduleJobsTemplate(jobs)}</div>
      ${scheduledViewRacePickSection()}
      <div id="scheduledResultsHost">${scheduledResultTableTemplate()}</div>
      <canvas id="noteCanvas" class="noteCanvas" aria-hidden="true"></canvas>
    </section>
  `
}

function scheduleTimeInputTemplate(time, index) {
  const removeDisabled = state.scheduled.draftTimes.length <= 1 ? 'disabled' : ''
  return `
    <div class="scheduleTimeRow">
      <label class="field">
        <span class="fieldLabel">時間${index + 1}（香港時間）</span>
        <input class="scheduleTimeInput" data-index="${index}" type="datetime-local" value="${escapeHtml(time)}" />
      </label>
      <button type="button" class="ghostBtn scheduleRemoveDraft" data-index="${index}" ${removeDisabled}>移除</button>
    </div>
  `
}

function scheduleJobsTemplate(jobs) {
  if (!jobs.length) {
    return `<div class="scheduledEmpty">尚未有預定提取時間。</div>`
  }

  syncScheduledViewJobsRaceForMeeting()
  const raceNo = state.scheduled.viewJobsRaceNo
  if (!raceNo) {
    if (meetingRaceCap() < 1) return ''
    return `<div class="scheduledEmpty">請選擇要檢視的場次。</div>`
  }
  const raceJobs = jobs.filter((job) => job.race_no === raceNo)
  if (!raceJobs.length) {
    return `<div class="scheduledEmpty">第${raceNo}場尚無預定提取。</div>`
  }

  const filtered = state.ui.hideCompletedJobs
    ? raceJobs.filter((job) => !isFinishedScheduleJob(job))
    : raceJobs
  if (!filtered.length) {
    return `<div class="scheduledEmpty">第${raceNo}場嘅已完成項目已隱藏。</div>`
  }

  return `
    <div class="scheduleJobList" aria-label="預定提取狀態">
      ${filtered.map((job) => `
        <div class="scheduleJobRow">
          <div>
            <strong>${escapeHtml(formatDateTimeHK(job.scheduled_at))}</strong>
            <span class="statusPill status-${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
            ${job.last_error ? `<div class="jobError">${escapeHtml(job.last_error)}</div>` : ''}
          </div>
          <div class="scheduleJobActions">
            ${job.status === 'pending' ? `<button type="button" class="ghostBtn scheduleDeleteJob" data-id="${escapeHtml(job.id)}">刪除</button>` : ''}
            ${['completed', 'failed', 'cancelled'].includes(job.status) ? `<button type="button" class="ghostBtn scheduleDeleteJobRecord" data-id="${escapeHtml(job.id)}">刪除紀錄</button>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `
}

function speedMapSectionForRace(raceNo) {
  const meta = state.scheduled.raceMetadata.find((row) => row.race_no === raceNo)
  if (!meta?.speed_map_url) return ''

  return `
    <div class="speedMapBlock" aria-label="第${raceNo}場走位圖">
      <div class="speedMapHeader">
        <h4 class="speedMapTitle">走位圖</h4>
        ${
          meta.speed_map_source_url
            ? `<a class="speedMapSourceLink" href="${escapeHtml(meta.speed_map_source_url)}" target="_blank" rel="noopener noreferrer">馬會來源</a>`
            : ''
        }
      </div>
      <img
        class="speedMapImage"
        src="${escapeHtml(meta.speed_map_url)}"
        alt="第${raceNo}場走位圖"
        loading="lazy"
      />
    </div>
  `
}

function scheduledResultTableForRace(raceNo) {
  const completedJobs = state.scheduled.jobs
    .filter((job) => job.status === 'completed' && job.race_no === raceNo)
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())

  const raceSnapshots = state.scheduled.snapshots.filter((row) => row.race_no === raceNo)
  const horseMap = new Map()
  for (const row of raceSnapshots) {
    if (row.horse_no == null) continue
    const existing = horseMap.get(row.horse_no) ?? {}
    horseMap.set(row.horse_no, {
      horse_no: row.horse_no,
      horse_name: existing.horse_name || row.horse_name || '',
      jockey_name: existing.withdrawn || row.withdrawn ? '' : existing.jockey_name || row.jockey_name || '',
      trainer_name:
        existing.withdrawn || row.withdrawn
          ? '(退出)'
          : existing.trainer_name || row.trainer_name || '',
      barrier: existing.withdrawn || row.withdrawn ? '' : existing.barrier || row.barrier || '',
      withdrawn: Boolean(existing.withdrawn || row.withdrawn)
    })
  }

  const horsesAll = [...horseMap.values()].sort((a, b) => Number(a.horse_no) - Number(b.horse_no))
  if (!completedJobs.length || !horsesAll.length) return ''
  const horses = state.ui.hideWithdrawnHorses ? horsesAll.filter((h) => !h.withdrawn) : horsesAll
  if (!horses.length) {
    return `<div class="scheduledEmpty">第${raceNo}場：已隱藏全部退出馬匹。</div>`
  }

  const byJobHorse = new Map()
  for (const row of raceSnapshots) {
    byJobHorse.set(`${row.job_id}:${row.horse_no}`, row)
  }

  const metaCell = (horse, column, value, className = '') =>
    highlightTd(className, scheduledMetaHighlightKey(raceNo, horse.horse_no, column), escapeHtml(value ?? ''))

  const oddsRow = (label, job, field) => `
    <tr>
      <th scope="row">${escapeHtml(label)}</th>
      ${horses.map((horse) => {
        const snap = byJobHorse.get(`${job.id}:${horse.horse_no}`)
        const value = horse.withdrawn || snap?.withdrawn ? '退出' : snap?.[field]
        const key = scheduledOddsHighlightKey(raceNo, job.id, horse.horse_no, field)
        const cellClass = horse.withdrawn || snap?.withdrawn ? 'oddCell isWithdrawn' : 'oddCell'
        return highlightTd(cellClass, key, escapeHtml(value ?? ''))
      }).join('')}
    </tr>
  `

  const manualOddsRow = (label, field) => `
    <tr>
      <th scope="row">${escapeHtml(label)}</th>
      ${horses
        .map((horse) => {
          const key = scheduledManualOddsHighlightKey(raceNo, horse.horse_no, field)
          if (horse.withdrawn) {
            return highlightTd('oddCell isWithdrawn', key, '退出')
          }
          const value = getManualOddsValue(raceNo, horse.horse_no, field)
          const inputClass = 'cellOddsInput'
          const inputAttrs = [
            `class="${inputClass}"`,
            'type="number"',
            'inputmode="decimal"',
            'step="any"',
            'min="0"',
            `data-race-no="${raceNo}"`,
            `data-horse-no="${horse.horse_no}"`,
            `data-field="${field}"`,
            `value="${escapeHtml(value)}"`,
            `aria-label="${escapeHtml(`${label} 馬${horse.horse_no}`)}"`
          ].join(' ')
          return `<td class="oddCell${highlightCellClassSuffix(key)}"${highlightDataAttr(key)}><input ${inputAttrs} /></td>`
        })
        .join('')}
    </tr>
  `

  return `
    <div class="scheduledTableBlock">
      <h3 class="scheduledTableRaceTitle">第${raceNo}場</h3>
      ${speedMapSectionForRace(raceNo)}
      <div class="scheduledTableWrap" role="region" aria-label="預定抄賠率結果 第${raceNo}場">
      <table class="scheduledTable${state.ui.hideFirstColumn ? ' hideFirstCol' : ''}">
        <thead>
          <tr>
            <th>馬號</th>
            ${horses
              .map((horse) =>
                highlightTh('', scheduledHeaderHighlightKey(raceNo, horse.horse_no), escapeHtml(String(horse.horse_no)))
              )
              .join('')}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">場次</th>
            ${horses.map((horse) => metaCell(horse, 'race', String(raceNo), 'numCell')).join('')}
          </tr>
          <tr>
            <th scope="row">馬名</th>
            ${horses.map((horse) => metaCell(horse, 'name', horse.horse_name, 'nameCell')).join('')}
          </tr>
          <tr>
            <th scope="row">騎師</th>
            ${horses.map((horse) => metaCell(horse, 'jockey', horse.jockey_name, 'textCell')).join('')}
          </tr>
          <tr>
            <th scope="row">練馬師</th>
            ${horses.map((horse) => metaCell(horse, 'trainer', horse.trainer_name, 'textCell')).join('')}
          </tr>
          <tr>
            <th scope="row">檔位</th>
            ${horses.map((horse) => metaCell(horse, 'barrier', horse.barrier, 'numCell')).join('')}
          </tr>
          ${manualOddsRow('獨贏', 'win')}
          ${completedJobs.map((job, index) => oddsRow(`時間${labelFromIndex(index)}(${formatMonthDayHmHK(job.scheduled_at)})`, job, 'win')).join('')}
          ${manualOddsRow('位置', 'place')}
          ${completedJobs.map((job, index) => oddsRow(`時間${labelFromIndex(index)}(${formatMonthDayHmHK(job.scheduled_at)})`, job, 'place')).join('')}
        </tbody>
      </table>
    </div>
    </div>
  `
}

function scheduledResultTableTemplate() {
  syncScheduledViewRaceForMeeting()
  const raceNo = state.scheduled.viewRaceNo
  if (!raceNo) {
    if (meetingRaceCap() < 1) return ''
    return `<div class="scheduledEmpty">請選擇要檢視的場次。</div>`
  }

  const anyCompleted = state.scheduled.jobs.some(
    (job) => job.status === 'completed' && job.race_no === raceNo
  )
  if (!anyCompleted) {
    return `<div class="scheduledEmpty">完成預定提取後，獨贏 / 位置結果會在此顯示。</div>`
  }

  return (
    scheduledResultTableForRace(raceNo) ||
    `<div class="scheduledEmpty">第${raceNo}場尚無可顯示的結果（可能全部為退出馬匹）。</div>`
  )
}

function mapDbRowToDisplayRow(r) {
  const withdrawn = Boolean(r.withdrawn)
  return {
    馬號: r.horse_no ?? '',
    馬名: r.horse_name ?? '',
    檔位: withdrawn ? '' : (r.barrier ?? ''),
    騎師: withdrawn ? '' : (r.jockey_name ?? ''),
    練馬師: withdrawn ? '(退出)' : (r.trainer_name ?? ''),
    獨贏: withdrawn ? '退出' : (r.win ?? ''),
    位置: withdrawn ? '退出' : (r.place ?? ''),
    withdrawn,
    isHot: false
  }
}

function rowTemplate(row) {
  const hotClass = row.isHot ? ' isHot' : ''
  const withdrawnClass = row.withdrawn ? ' isWithdrawn' : ''
  const rowAttrs = row.withdrawn ? ' class="isWithdrawnRow"' : ''
  const horseNo = row.馬號
  const winClass = `oddCell${hotClass}${withdrawnClass}`
  const placeClass = `oddCell${hotClass}${withdrawnClass}`
  return `
    <tr${rowAttrs}>
      ${highlightTd('numCell', liveHighlightKey(horseNo, 'race'), escapeHtml(String(state.篩選.場次編號)))}
      ${highlightTd('numCell', liveHighlightKey(horseNo, 'no'), escapeHtml(String(horseNo)))}
      ${highlightTd('nameCell colTextCenter', liveHighlightKey(horseNo, 'name'), escapeHtml(row.馬名))}
      ${highlightTd('numCell', liveHighlightKey(horseNo, 'barrier'), escapeHtml(String(row.檔位)))}
      ${highlightTd('textCell colTextCenter', liveHighlightKey(horseNo, 'jockey'), escapeHtml(row.騎師))}
      ${highlightTd('textCell colTextCenter', liveHighlightKey(horseNo, 'trainer'), escapeHtml(row.練馬師))}
      ${highlightTd(winClass, liveHighlightKey(horseNo, 'win'), escapeHtml(String(row.獨贏)))}
      ${highlightTd(placeClass, liveHighlightKey(horseNo, 'place'), escapeHtml(String(row.位置)))}
    </tr>
  `
}

function renderLiveOddsTableHead() {
  const thead = document.querySelector('#panelLive .oddsTable thead')
  if (!thead) return
  thead.innerHTML = liveOddsTableHeadRow()
}

function renderLiveOddsTableBody() {
  const tbody = document.querySelector('#panelLive .oddsTable tbody')
  if (!tbody) return
  tbody.innerHTML = visibleLiveRows().map((row) => rowTemplate(row)).join('')
}

function renderLiveOddsTable() {
  renderLiveOddsTableHead()
  renderLiveOddsTableBody()
  const tbl = document.querySelector('#panelLive .oddsTable')
  if (tbl) tbl.classList.toggle('hideFirstCol', state.ui.hideFirstColumn)
}

function showToast(msg) {
  const el = document.querySelector('#snackbar')
  if (!el) return
  el.textContent = msg
  el.classList.add('isVisible')
  window.clearTimeout(showToast._t)
  showToast._t = window.setTimeout(() => el.classList.remove('isVisible'), 1800)
}

function readFilterFromInputs() {
  const raceDate = document.querySelector('#raceDate')?.value?.trim()
  const meetingCode = state.篩選.會場代號
  const raceNoRaw = document.querySelector('#raceNo')?.value

  const raceNo = Number(raceNoRaw)
  if (!raceDate || !meetingCode || !Number.isFinite(raceNo) || raceNo < 1) {
    throw new Error('請填寫正確的 賽馬日 / 場次')
  }

  state.篩選.賽馬日 = raceDate
  state.篩選.會場代號 = meetingCode
  state.篩選.場次編號 = String(Math.trunc(raceNo))
  return { raceDate, meetingCode, raceNo: Math.trunc(raceNo) }
}

function readFilterQuiet() {
  const raceDate = document.querySelector('#raceDate')?.value?.trim() || state.篩選.賽馬日
  const meetingCode = state.篩選.會場代號
  const raceNoRaw = document.querySelector('#raceNo')?.value || state.篩選.場次編號
  const raceNo = Number(raceNoRaw)
  if (!raceDate || !meetingCode || !Number.isFinite(raceNo) || raceNo < 1) return null
  return { raceDate, meetingCode, raceNo: Math.trunc(raceNo) }
}

/** 預定抄賠率：同一賽馬日＋會場下的所有場次（不限單一場次步進器） */
function readScheduledScopeFilter() {
  const raceDate = document.querySelector('#raceDate')?.value?.trim() || state.篩選.賽馬日
  const meetingCode = state.篩選.會場代號
  if (!raceDate || !meetingCode) {
    throw new Error('請填寫正確的 賽馬日 / 會場')
  }
  state.篩選.賽馬日 = raceDate
  return { raceDate, meetingCode }
}

let meetingsLoadSeq = 0

function clampRaceNoForCurrentMeeting() {
  const curMeeting = state.ui.dayMeetings.find((m) => m.venueCode === state.篩選.會場代號)
  const maxRace = curMeeting?.totalNumberOfRace
  let cap = 99
  if (maxRace != null && maxRace >= 1) cap = Math.min(99, maxRace)
  let n = Number(state.篩選.場次編號)
  if (!Number.isFinite(n)) n = 1
  state.篩選.場次編號 = String(Math.min(cap, Math.max(1, Math.trunc(n))))
}

function applyMeetingSelectionFromDayList(list) {
  if (!list.length) return
  const codes = new Set(list.map((m) => m.venueCode))
  if (!codes.has(state.篩選.會場代號)) {
    const prefer =
      list.find((m) => m.venueCode === 'ST') ??
      list.find((m) => m.venueCode === 'HV') ??
      list[0]
    state.篩選.會場代號 = prefer.venueCode
  }
  clampRaceNoForCurrentMeeting()
}

function syncHkjcWpLinkHref() {
  const f = readFilterQuiet()
  if (!f) return
  let raceNo = f.raceNo
  if (state.ui.bottomTab === 'scheduled') {
    syncScheduledViewRaceForMeeting()
    if (state.scheduled.viewRaceNo) raceNo = state.scheduled.viewRaceNo
  }
  const href = buildHkjcWpOddsUrl('ch', f.raceDate, f.meetingCode, raceNo)
  document.querySelectorAll('#linkHkjcWp, #linkHkjcWpScheduled').forEach((el) => {
    el.href = href
  })
}

function refreshLiveOddsTableQuiet() {
  const quietFilter = readFilterQuiet()
  if (!supabase || !quietFilter) return
  loadLatestResults(quietFilter)
    .then(() => {
      renderLiveOddsTable()
    })
    .catch((e) => {
      const message = String(e?.message ?? e)
      showToast(`即時賠率自動更新失敗：${message}`)
    })
}

/** On entry: show cached odds, then refresh only the current race (not the whole card). */
async function refreshAllLiveOddsOnEntry() {
  if (!supabase) return
  const raceDate = state.篩選.賽馬日
  const meetingCode = state.篩選.會場代號
  const raceNo = Number(state.篩選.場次編號)
  if (!raceDate || !meetingCode || meetingRaceCap() < 1 || !Number.isFinite(raceNo) || raceNo < 1) return

  const filter = { raceDate, meetingCode, raceNo: Math.trunc(raceNo) }
  try {
    await loadLatestResults(filter)
    renderLiveOddsTable()
  } catch {
    // ignore — extract below may still succeed
  }

  showToast('正在更新即時賠率…')
  try {
    await runExtractNow(filter)
    const n = await loadLatestResults(filter)
    renderLiveOddsTable()
    if (n) showToast(`已更新 ${n} 筆即時賠率`)
    else showToast('暫未能取得即時賠率（可能尚未開盤）')
  } catch {
    showToast('暫未能取得即時賠率（可能尚未開盤）')
  }
}

async function loadMeetingsForSelectedDate(options = {}) {
  const resetScheduledTargets = options.resetScheduledTargets !== false
  const seq = ++meetingsLoadSeq
  state.ui.meetingsLoading = true
  if (resetScheduledTargets) {
    state.scheduled.targetRaceNos = []
    state.scheduled.viewRaceNo = null
    state.scheduled.viewJobsRaceNo = null
  }
  mount()
  try {
    const list = await fetchMeetingsForCalendarDate(state.篩選.賽馬日)
    if (seq !== meetingsLoadSeq) return
    state.ui.dayMeetings = list
    applyMeetingSelectionFromDayList(list)
  } catch (e) {
    if (seq !== meetingsLoadSeq) return
    state.ui.dayMeetings = []
    showToast(String(e?.message ?? e))
  } finally {
    if (seq !== meetingsLoadSeq) return
    state.ui.meetingsLoading = false
    mount()
    scheduleRefreshRaceSubtitle(0)
    syncHkjcWpLinkHref()
  }
}

let subtitleRefreshTimer = 0

function setRaceSubtitleText(text) {
  state.賽事.subtitle = text
  syncAppBarHeadline()
}

async function refreshRaceSubtitle() {
  const f = readFilterQuiet()
  if (!f) {
    setRaceSubtitleText('請選擇賽馬日及場次')
    return
  }
  let raceNo = f.raceNo
  if (state.ui.bottomTab === 'scheduled') {
    syncScheduledViewRaceForMeeting()
    if (state.scheduled.viewRaceNo) raceNo = state.scheduled.viewRaceNo
  }
  setRaceSubtitleText('載入中…')
  try {
    const text = await fetchRaceSubtitle(f.raceDate, f.meetingCode, raceNo)
    setRaceSubtitleText(text)
  } catch {
    setRaceSubtitleText(`第${raceNo}場 · ${f.raceDate} · 會場 ${f.meetingCode}`)
  }
}

function scheduleRefreshRaceSubtitle(delayMs = 0) {
  window.clearTimeout(subtitleRefreshTimer)
  subtitleRefreshTimer = window.setTimeout(() => {
    refreshRaceSubtitle().catch(() => {
      const f = readFilterQuiet()
      if (f) setRaceSubtitleText(`第${f.raceNo}場 · ${f.raceDate} · 會場 ${f.meetingCode}`)
    })
  }, delayMs)
}

/** PostgREST caps each response at 1000 rows; paginate for full meeting-day snapshot history. */
async function fetchAllSupabaseRows(buildQuery, pageSize = 1000) {
  const all = []
  let from = 0
  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await buildQuery().range(from, to)
    if (error) throw new Error(error.message)
    const page = data ?? []
    all.push(...page)
    if (page.length < pageSize) break
    from += pageSize
  }
  return all
}

async function loadLatestResults({ raceDate, meetingCode, raceNo }) {
  assertSupabaseConfigured()
  const { data, error } = await supabase
    .from('race_results')
    .select('horse_no,horse_name,barrier,jockey_name,trainer_name,win,place,withdrawn')
    .eq('race_date', raceDate)
    .eq('meeting_code', meetingCode)
    .eq('race_no', raceNo)
    .order('horse_no', { ascending: true })

  if (error) throw new Error(error.message)

  if (!data?.length) {
    rows = []
    return 0
  }

  rows = data.map((r) => mapDbRowToDisplayRow(r))
  return rows.length
}

async function runExtractNow({ raceDate, meetingCode, raceNo }) {
  assertSupabaseConfigured()
  const { data, error } = await supabase.functions.invoke('extract-race-results', {
    body: { raceDate, meetingCode, raceNo }
  })
  if (error) throw new Error(await readFunctionError(error))
  if (!data?.ok) throw new Error(data?.error ?? '提取失敗')
  return data
}

function isScheduledJobDue(job) {
  if (job.status !== 'pending' || !job.scheduled_at) return false
  return new Date(job.scheduled_at).getTime() <= Date.now()
}

function hasDuePendingJobs(jobs = state.scheduled.jobs) {
  return jobs.some(isScheduledJobDue)
}

async function processDueScheduledJobs() {
  assertSupabaseConfigured()
  const { data, error } = await supabase.functions.invoke('process-user-due-extractions', {
    body: {}
  })
  if (error) throw new Error(await readFunctionError(error))
  if (!data?.ok) throw new Error(data?.error ?? '預定提取失敗')
  return data
}

function stopScheduleDuePoll() {
  if (scheduleDuePollTimer != null) {
    window.clearInterval(scheduleDuePollTimer)
    scheduleDuePollTimer = null
  }
}

function startScheduleDuePoll() {
  stopScheduleDuePoll()
  scheduleDuePollTimer = window.setInterval(() => {
    if (state.ui.bottomTab !== 'scheduled' || state.scheduled.loading) return
    if (!hasDuePendingJobs()) return
    processDueScheduledJobs()
      .then(() => loadScheduledData(true, { processDue: false }))
      .catch((e) => {
        const message = String(e?.message ?? e)
        showToast(`預定自動提取失敗：${message}`)
      })
  }, 30_000)
}

async function loadScheduledData(force = false, { processDue = true } = {}) {
  const scope = readScheduledScopeFilter()
  assertSupabaseConfigured()

  const key = `${scope.raceDate}:${scope.meetingCode}`
  if (!force && state.scheduled.loadedKey === key && state.scheduled.jobs.length) return

  state.scheduled.loading = true
  renderScheduledPanel()
  try {
    const jobs = await fetchAllSupabaseRows(() =>
      supabase
        .from('race_extraction_jobs')
        .select('id,race_date,meeting_code,race_no,scheduled_at,status,last_error,last_run_at,completed_at,created_at')
        .eq('race_date', scope.raceDate)
        .eq('meeting_code', scope.meetingCode)
        .order('race_no', { ascending: true })
        .order('scheduled_at', { ascending: true })
    )

    const snapshots = await fetchAllSupabaseRows(() =>
      supabase
        .from('race_extraction_snapshots')
        .select('job_id,race_no,horse_no,horse_name,barrier,jockey_name,trainer_name,win,place,withdrawn,extracted_at')
        .eq('race_date', scope.raceDate)
        .eq('meeting_code', scope.meetingCode)
        .order('race_no', { ascending: true })
        .order('horse_no', { ascending: true })
        .order('extracted_at', { ascending: true })
    )

    const raceMetadata = await fetchAllSupabaseRows(() =>
      supabase
        .from('race_metadata')
        .select('race_no,speed_map_url,speed_map_source_url,captured_at')
        .eq('race_date', scope.raceDate)
        .eq('meeting_code', scope.meetingCode)
        .order('race_no', { ascending: true })
    )

    state.scheduled.jobs = jobs
    state.scheduled.snapshots = snapshots
    state.scheduled.raceMetadata = raceMetadata
    state.scheduled.loadedKey = key
    syncScheduledViewRaceForMeeting()
  } catch (e) {
    showToast(String(e?.message ?? e))
  } finally {
    state.scheduled.loading = false
    renderScheduledPanel()
  }

  if (processDue && hasDuePendingJobs(state.scheduled.jobs)) {
    try {
      showToast('預定時間已到，提取中…')
      const outcome = await processDueScheduledJobs()
      const succeeded = outcome?.results?.filter((r) => r.ok).length ?? 0
      const failed = outcome?.results?.filter((r) => !r.ok).length ?? 0
      await loadScheduledData(true, { processDue: false })
      if (succeeded) showToast(`已完成 ${succeeded} 個預定提取`)
      else if (failed) showToast('預定提取失敗，請查看列表中的錯誤訊息')
    } catch (e) {
      showToast(String(e?.message ?? e))
    }
  }
}

async function saveScheduleTimes() {
  const scope = readScheduledScopeFilter()
  syncScheduledTargetRacesForMeeting()
  const raceNos = [...state.scheduled.targetRaceNos]
  if (!raceNos.length) throw new Error('請至少選擇一個預定場次')

  assertSupabaseConfigured()
  const uniqueTimes = [...new Set(state.scheduled.draftTimes.map((time) => time.trim()).filter(Boolean))]

  if (!uniqueTimes.length) throw new Error('請新增至少一個預定時間')

  const rowsToInsert = []
  for (const raceNo of raceNos) {
    for (const time of uniqueTimes) {
      rowsToInsert.push({
        race_date: scope.raceDate,
        meeting_code: scope.meetingCode,
        race_no: raceNo,
        scheduled_at: parseHKDateTimeLocalToISO(time),
        status: 'pending'
      })
    }
  }

  const { error } = await supabase.from('race_extraction_jobs').insert(rowsToInsert)
  if (error) throw new Error(error.message)
  state.scheduled.draftTimes = [toDateTimeLocalValueHK(new Date(Date.now() + 5 * 60 * 1000))]
  await loadScheduledData(true)
  return rowsToInsert.length
}

async function deleteScheduleJob(id) {
  assertSupabaseConfigured()
  const { error } = await supabase
    .from('race_extraction_jobs')
    .delete()
    .eq('id', id)
    .eq('status', 'pending')

  if (error) throw new Error(error.message)
  await loadScheduledData(true)
}

async function deleteScheduleJobRecord(id) {
  assertSupabaseConfigured()
  const { error } = await supabase
    .from('race_extraction_jobs')
    .delete()
    .eq('id', id)
    .in('status', ['completed', 'failed', 'cancelled'])

  if (error) throw new Error(error.message)
  await loadScheduledData(true)
}

async function readFunctionError(error) {
  const fallback = error?.message ?? 'Edge Function failed'
  const context = error?.context

  try {
    if (context && typeof context.json === 'function') {
      const body = await context.json()
      if (body?.error) return body.details ? `${body.error}: ${body.details}` : body.error
      return JSON.stringify(body)
    }
    if (context && typeof context.text === 'function') {
      return await context.text()
    }
  } catch {
    // The response body may already be consumed by Supabase.
  }

  return fallback
}

function setBottomTab(which) {
  if (which !== 'live' && which !== 'scheduled') return
  state.ui.bottomTab = which
  persistBottomTab(which)
  const live = which === 'live'

  const pLive = document.querySelector('#panelLive')
  const pSch = document.querySelector('#panelScheduled')
  const bLive = document.querySelector('#tabLiveBtn')
  const bSch = document.querySelector('#tabScheduledBtn')

  if (pLive) {
    if (live) pLive.removeAttribute('hidden')
    else pLive.setAttribute('hidden', '')
  }
  if (pSch) {
    if (!live) pSch.removeAttribute('hidden')
    else pSch.setAttribute('hidden', '')
  }

  bLive?.classList.toggle('isActive', live)
  bSch?.classList.toggle('isActive', !live)
  bLive?.setAttribute('aria-selected', live ? 'true' : 'false')
  bSch?.setAttribute('aria-selected', !live ? 'true' : 'false')

  if (live) stopScheduleDuePoll()
  else startScheduleDuePoll()

  const raceMulti = document.querySelector('#controlsRowRaceMulti')
  if (raceMulti) {
    if (live) raceMulti.setAttribute('hidden', '')
    else raceMulti.removeAttribute('hidden')
  }

  syncAppBarHeadline()
  syncLiveOnlyChrome()
  if (!live) {
    renderScheduleRacePickInDom()
    renderScheduleViewRacePickInDom()
    renderScheduleViewJobsRacePickInDom()
    scheduleRefreshRaceSubtitle(0)
    syncHkjcWpLinkHref()
  }
}

/** 預定抄賠率分頁：隱藏僅適用即時賠率的頂部重新整理與「場次」步進器 */
function syncLiveOnlyChrome() {
  const live = state.ui.bottomTab === 'live'
  document.querySelector('.appBar')?.classList.toggle('appBarScheduled', !live)
  const ref = document.querySelector('#btnRefresh')
  if (ref) {
    if (live) ref.removeAttribute('hidden')
    else ref.setAttribute('hidden', '')
  }
  const raceNo = document.querySelector('#controlsFieldRaceNo')
  if (raceNo) {
    if (live) raceNo.removeAttribute('hidden')
    else raceNo.setAttribute('hidden', '')
  }
  document.querySelector('#controlsRowFiltersBar')?.classList.toggle('controlsRowFiltersBar--twoCol', !live)
}

function renderScheduledPanel() {
  const panel = document.querySelector('#panelScheduled')
  if (!panel) return
  panel.innerHTML = scheduledTemplate()
  bindScheduledEvents()
  bindScheduleViewRacePickButtons()
  bindScheduleViewJobsRacePickButtons()
  syncHkjcWpLinkHref()
  syncHideWithdrawnToggleLabels()
  syncHighlighterToggleLabels()
  syncNoteModeDom()
  bindNoteCanvasEvents()
}

function updateScheduleRacePickButtonsInDom() {
  const selected = new Set(state.scheduled.targetRaceNos)
  document.querySelectorAll('.scheduleRacePick').forEach((btn) => {
    const r = Number(btn.dataset.raceNo)
    const isOn = selected.has(r)
    btn.classList.toggle('scheduleRacePickActive', isOn)
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false')
  })
}

function bindScheduleRacePickButtons() {
  document.querySelectorAll('.scheduleRacePick').forEach((button) => {
    button.addEventListener('click', () => {
      const r = Number(button.dataset.raceNo)
      if (!Number.isFinite(r) || r < 1) return
      const set = new Set(state.scheduled.targetRaceNos)
      if (set.has(r)) {
        if (set.size <= 1) {
          showToast('請至少保留一個場次')
          return
        }
        set.delete(r)
      } else {
        set.add(r)
      }
      state.scheduled.targetRaceNos = [...set].sort((a, b) => a - b)
      updateScheduleRacePickButtonsInDom()
      if (supabase) renderScheduledPanel()
    })
  })
}

function bindScheduleViewRacePickButtons() {
  document.querySelectorAll('.scheduleViewRacePick').forEach((button) => {
    button.addEventListener('click', () => {
      const r = Number(button.dataset.raceNo)
      if (!Number.isFinite(r) || r < 1) return
      if (r === state.scheduled.viewRaceNo) return
      state.scheduled.viewRaceNo = r
      updateScheduleViewRacePickButtonsInDom()
      const resultsHost = document.querySelector('#scheduledResultsHost')
      if (resultsHost) {
        resultsHost.innerHTML = scheduledResultTableTemplate()
      } else if (supabase) {
        renderScheduledPanel()
      }
      scheduleRefreshRaceSubtitle(0)
      syncHkjcWpLinkHref()
    })
  })
}

function bindScheduleViewJobsRacePickButtons() {
  document.querySelectorAll('.scheduleViewJobsRacePick').forEach((button) => {
    button.addEventListener('click', () => {
      const r = Number(button.dataset.raceNo)
      if (!Number.isFinite(r) || r < 1) return
      if (r === state.scheduled.viewJobsRaceNo) return
      state.scheduled.viewJobsRaceNo = r
      updateScheduleViewJobsRacePickButtonsInDom()
      renderScheduleJobsListInDom()
    })
  })
}

function bindScheduleJobListActions() {
  document.querySelectorAll('.scheduleDeleteJob').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.id
      if (!id) return
      deleteScheduleJob(id)
        .then(() => showToast('已刪除預定時間'))
        .catch((e) => showToast(String(e?.message ?? e)))
    })
  })

  document.querySelectorAll('.scheduleDeleteJobRecord').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.id
      if (!id) return
      if (!window.confirm('確定刪除此筆已完成／失敗的提取紀錄？（不可還原）')) return
      deleteScheduleJobRecord(id)
        .then(() => showToast('已刪除紀錄'))
        .catch((e) => showToast(String(e?.message ?? e)))
    })
  })
}

function toggleHideWithdrawnHorses() {
  state.ui.hideWithdrawnHorses = !state.ui.hideWithdrawnHorses
  renderLiveOddsTable()
  if (supabase) renderScheduledPanel()
  syncHideWithdrawnToggleLabels()
}

function syncHideCompletedJobsToggleLabels() {
  const on = state.ui.hideCompletedJobs
  document.querySelectorAll('.toggleHideCompletedJobsBtn').forEach((btn) => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.textContent = on ? '顯示已完成項目' : '隱藏已完成項目'
  })
}

function syncHideWithdrawnToggleLabels() {
  const on = state.ui.hideWithdrawnHorses
  document.querySelectorAll('.toggleHideWithdrawnBtn').forEach((btn) => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.textContent = on ? '顯示退出馬匹' : '隱藏退出馬匹'
  })
}

function syncHighlighterModeDom() {
  document.body.classList.toggle('highlighterMode', state.ui.highlighterMode)
  syncHighlighterToggleLabels()
  syncHighlighterColorPicker()
}

function toggleHighlighterMode() {
  state.ui.highlighterMode = !state.ui.highlighterMode
  syncHighlighterModeDom()
  showToast(state.ui.highlighterMode ? '熒光筆已開啟：點選表格格以標示' : '熒光筆已關閉')
}

function syncNoteModeDom() {
  document.body.classList.toggle('noteMode', state.ui.noteMode)
  document.querySelectorAll('.noteToolGroup').forEach((group) => {
    group.classList.toggle('isOpen', state.ui.noteMode)
  })
  document.querySelectorAll('.toggleNoteBtn').forEach((btn) => {
    btn.setAttribute('aria-pressed', state.ui.noteMode ? 'true' : 'false')
    btn.textContent = state.ui.noteMode ? '關閉筆記' : '筆記'
  })
  document.querySelectorAll('.clearNoteBtn').forEach((btn) => {
    if (state.ui.noteMode) {
      btn.removeAttribute('hidden')
      btn.removeAttribute('aria-hidden')
    } else {
      btn.setAttribute('hidden', '')
      btn.setAttribute('aria-hidden', 'true')
    }
  })
  document.querySelectorAll('.noteColorRow').forEach((row) => {
    row.setAttribute('aria-hidden', state.ui.noteMode ? 'false' : 'true')
  })
  document.querySelectorAll('.noteColorBtn').forEach((btn) => {
    const id = btn.dataset.noteColor
    const isOn = id === state.ui.noteColor
    btn.classList.toggle('isActive', isOn)
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false')
    btn.tabIndex = state.ui.noteMode ? 0 : -1
  })
  document.querySelectorAll('.toggleEraserBtn').forEach((btn) => {
    if (state.ui.noteMode) {
      btn.removeAttribute('hidden')
      btn.removeAttribute('aria-hidden')
    } else {
      btn.setAttribute('hidden', '')
      btn.setAttribute('aria-hidden', 'true')
    }
    const isEraser = state.ui.noteTool === 'eraser'
    btn.classList.toggle('isActive', isEraser)
    btn.setAttribute('aria-pressed', isEraser ? 'true' : 'false')
  })
  syncNoteCanvasInteractivity()
}

function toggleNoteMode() {
  state.ui.noteMode = !state.ui.noteMode
  if (!state.ui.noteMode) state.ui.noteTool = 'pen'
  syncNoteModeDom()
  showToast(state.ui.noteMode ? '筆記已開啟：用紅筆喺頁面寫低重點' : '筆記已關閉')
}

function toggleEraser() {
  state.ui.noteTool = state.ui.noteTool === 'eraser' ? 'pen' : 'eraser'
  syncNoteModeDom()
  showToast(state.ui.noteTool === 'eraser' ? '橡皮擦：喺畫面上擦走筆記' : '已切換返畫筆')
}

function clearNote() {
  state.ui.noteStrokes = []
  redrawNoteCanvas()
  showToast('已清除筆記')
}

function getNoteCanvas() {
  return document.querySelector('#noteCanvas')
}

function resizeNoteCanvasToHost() {
  const canvas = getNoteCanvas()
  if (!canvas) return
  const host = canvas.closest('.noteHost')
  if (!host) return

  const cssW = Math.max(1, Math.round(host.clientWidth))
  const cssH = Math.max(1, Math.round(host.scrollHeight))
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))

  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`

  const pxW = Math.max(1, Math.round(cssW * dpr))
  const pxH = Math.max(1, Math.round(cssH * dpr))
  if (canvas.width !== pxW) canvas.width = pxW
  if (canvas.height !== pxH) canvas.height = pxH

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function redrawNoteCanvas() {
  const canvas = getNoteCanvas()
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  resizeNoteCanvasToHost()

  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)

  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const stroke of state.ui.noteStrokes) {
    // Back-compat: old shape was points[]
    const points = Array.isArray(stroke) ? stroke : stroke?.points
    const color = Array.isArray(stroke) ? '#ef4444' : (stroke?.color || '#ef4444')
    const tool = Array.isArray(stroke) ? 'pen' : (stroke?.tool || 'pen')
    if (!Array.isArray(points) || points.length < 2) continue
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = color
    ctx.lineWidth = tool === 'eraser' ? 14 : 2
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) {
      const p = points[i]
      if (!p) continue
      ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }
}

function syncNoteCanvasInteractivity() {
  const canvas = getNoteCanvas()
  if (!canvas) return
  canvas.classList.toggle('isEnabled', state.ui.noteMode)
  canvas.setAttribute('aria-hidden', state.ui.noteMode ? 'false' : 'true')
  redrawNoteCanvas()
}

function bindNoteCanvasEvents() {
  const canvas = getNoteCanvas()
  if (!canvas) return

  noteCanvasAbort?.abort()
  noteCanvasAbort = new AbortController()

  let drawing = false
  let currentStroke = null

  const toPoint = (e) => {
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return { x: Math.max(0, x), y: Math.max(0, y) }
  }

  const start = (e) => {
    if (!state.ui.noteMode) return
    if (e.button != null && e.button !== 0) return
    drawing = true
    currentStroke = {
      color: NOTE_COLORS.find((c) => c.id === state.ui.noteColor)?.css ?? '#ef4444',
      tool: state.ui.noteTool,
      points: [toPoint(e)]
    }
    state.ui.noteStrokes.push(currentStroke)
    canvas.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  const move = (e) => {
    if (!state.ui.noteMode || !drawing || !currentStroke) return
    currentStroke.points.push(toPoint(e))

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const tool = currentStroke.tool || 'pen'
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = currentStroke.color || '#ef4444'
    ctx.lineWidth = tool === 'eraser' ? 14 : 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const n = currentStroke.points.length
    if (n < 2) return
    const a = currentStroke.points[n - 2]
    const b = currentStroke.points[n - 1]
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    e.preventDefault()
  }

  const end = (e) => {
    if (!drawing) return
    drawing = false
    currentStroke = null
    e.preventDefault()
  }

  canvas.addEventListener('pointerdown', start, { signal: noteCanvasAbort.signal })
  canvas.addEventListener('pointermove', move, { signal: noteCanvasAbort.signal })
  canvas.addEventListener('pointerup', end, { signal: noteCanvasAbort.signal })
  canvas.addEventListener('pointercancel', end, { signal: noteCanvasAbort.signal })

  window.addEventListener('resize', () => redrawNoteCanvas(), { signal: noteCanvasAbort.signal })
}

function syncHighlighterToggleLabels() {
  const on = state.ui.highlighterMode
  document.querySelectorAll('.toggleHighlighterBtn').forEach((btn) => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.textContent = on ? '關閉熒光筆' : '熒光筆'
  })
}

function persistHighlighterColor() {
  try {
    localStorage.setItem(HIGHLIGHT_COLOR_STORAGE_KEY, state.ui.highlighterColor)
  } catch {
    /* ignore */
  }
}

function restoreHighlighterColorFromStorage() {
  try {
    const v = localStorage.getItem(HIGHLIGHT_COLOR_STORAGE_KEY)
    if (typeof v === 'string' && HIGHLIGHT_COLORS.some((c) => c.id === v)) {
      state.ui.highlighterColor = v
      return
    }
  } catch {
    /* ignore */
  }
  state.ui.highlighterColor = 'yellow'
}

function syncHighlighterColorPicker() {
  const on = state.ui.highlighterMode
  document.querySelectorAll('.hlToolGroup').forEach((group) => {
    group.classList.toggle('isOpen', on)
  })
  document.querySelectorAll('.hlColorRow').forEach((row) => {
    row.setAttribute('aria-hidden', on ? 'false' : 'true')
  })
  document.querySelectorAll('.hlColorBtn').forEach((btn) => {
    const id = btn.dataset.hlColor
    const isOn = id === state.ui.highlighterColor
    btn.classList.toggle('isActive', isOn)
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false')
    btn.tabIndex = on ? 0 : -1
  })
}

function bindScheduledEvents() {
  document.querySelector('#btnAddScheduleTime')?.addEventListener('click', () => {
    const last = state.scheduled.draftTimes.at(-1)
    let next
    try {
      next = last
        ? new Date(new Date(parseHKDateTimeLocalToISO(last)).getTime() + 5 * 60 * 1000)
        : new Date(Date.now() + 5 * 60 * 1000)
    } catch {
      next = new Date(Date.now() + 5 * 60 * 1000)
    }
    state.scheduled.draftTimes.push(toDateTimeLocalValueHK(next))
    renderScheduledPanel()
  })

  document.querySelector('#btnSaveScheduleTimes')?.addEventListener('click', () => {
    showToast('儲存預定時間中…')
    saveScheduleTimes()
      .then((n) => showToast(`已儲存 ${n} 筆預定（所選場次各一組時間）`))
      .catch((e) => showToast(String(e?.message ?? e)))
  })

  document.querySelectorAll('.scheduleTimeInput').forEach((input) => {
    input.addEventListener('change', () => {
      const index = Number(input.dataset.index)
      if (Number.isFinite(index)) state.scheduled.draftTimes[index] = input.value
    })
  })

  document.querySelectorAll('.scheduleRemoveDraft').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index)
      if (state.scheduled.draftTimes.length > 1 && Number.isFinite(index)) {
        state.scheduled.draftTimes.splice(index, 1)
        renderScheduledPanel()
      }
    })
  })

  bindScheduleJobListActions()
}

function resetScheduledLoadedKey() {
  state.scheduled.loadedKey = ''
  state.scheduled.jobs = []
  state.scheduled.snapshots = []
  if (state.ui.bottomTab === 'scheduled') {
    renderScheduledPanel()
    loadScheduledData(true).catch((e) => showToast(String(e?.message ?? e)))
  }
}

async function bootstrap() {
  restoreBottomTabFromStorage()
  restoreHideFirstColumnFromStorage()
  restoreHideCompletedJobsFromStorage()
  restoreHighlighterColorFromStorage()
  restoreManualOddsFromStorage()
  mount()
  try {
    await loadMeetingsForSelectedDate()
    await refreshAllLiveOddsOnEntry()
  } catch (e) {
    showToast(String(e?.message ?? e))
  }
}

function statusLabel(status) {
  return {
    pending: '待提取',
    running: '提取中',
    completed: '已完成',
    failed: '失敗',
    cancelled: '已取消'
  }[status] ?? status
}

function labelFromIndex(index) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  if (index < alphabet.length) return alphabet[index]
  return String(index + 1)
}

function mount() {
  document.querySelector('#app').innerHTML = appTemplate()
  bindScheduledEvents()
  bindScheduleRacePickButtons()

  hideWithdrawnClickDelegationAbort?.abort()
  hideWithdrawnClickDelegationAbort = new AbortController()
  document.querySelector('#app')?.addEventListener(
    'click',
    (e) => {
      if (!e.target.closest('.toggleHideWithdrawnBtn')) return
      e.preventDefault()
      toggleHideWithdrawnHorses()
    },
    { signal: hideWithdrawnClickDelegationAbort.signal }
  )

  document.querySelector('#app')?.addEventListener(
    'click',
    (e) => {
      if (!e.target.closest('.toggleHideFirstColBtn')) return
      e.preventDefault()
      state.ui.hideFirstColumn = !state.ui.hideFirstColumn
      persistHideFirstColumn()
      renderLiveOddsTable()
      if (supabase) renderScheduledPanel()
      document.querySelectorAll('.toggleHideFirstColBtn').forEach((btn) => {
        btn.setAttribute('aria-pressed', state.ui.hideFirstColumn ? 'true' : 'false')
        btn.textContent = state.ui.hideFirstColumn ? '顯示左欄' : '隱藏左欄'
      })
    },
    { signal: hideWithdrawnClickDelegationAbort.signal }
  )

  document.querySelector('#app')?.addEventListener(
    'click',
    (e) => {
      if (!e.target.closest('.toggleHideCompletedJobsBtn')) return
      e.preventDefault()
      state.ui.hideCompletedJobs = !state.ui.hideCompletedJobs
      persistHideCompletedJobs()
      renderScheduleJobsListInDom()
      syncHideCompletedJobsToggleLabels()
    },
    { signal: hideWithdrawnClickDelegationAbort.signal }
  )

  highlighterClickDelegationAbort?.abort()
  highlighterClickDelegationAbort = new AbortController()
  document.querySelector('#app')?.addEventListener(
    'click',
    (e) => {
      if (e.target.closest('.toggleHighlighterBtn')) {
        e.preventDefault()
        toggleHighlighterMode()
        return
      }
      if (e.target.closest('.toggleNoteBtn')) {
        e.preventDefault()
        toggleNoteMode()
        return
      }
      if (e.target.closest('.clearNoteBtn')) {
        e.preventDefault()
        clearNote()
        return
      }
      if (e.target.closest('.toggleEraserBtn')) {
        e.preventDefault()
        if (!state.ui.noteMode) return
        toggleEraser()
        return
      }
      const noteColorBtn = e.target.closest('.noteColorBtn')
      if (noteColorBtn) {
        e.preventDefault()
        const id = noteColorBtn.dataset.noteColor
        if (id && NOTE_COLORS.some((c) => c.id === id)) {
          state.ui.noteColor = id
          state.ui.noteTool = 'pen'
          syncNoteModeDom()
        }
        return
      }
      const colorBtn = e.target.closest('.hlColorBtn')
      if (colorBtn) {
        e.preventDefault()
        const id = colorBtn.dataset.hlColor
        if (id && HIGHLIGHT_COLORS.some((c) => c.id === id)) {
          state.ui.highlighterColor = id
          persistHighlighterColor()
          syncHighlighterColorPicker()
        }
        return
      }
      if (e.target.closest('.cellOddsInput')) return
      if (!state.ui.highlighterMode) return
      const cell = e.target.closest('[data-highlight-key]')
      if (!cell) return
      const key = cell.dataset.highlightKey
      if (!key) return
      toggleCellHighlight(key, state.ui.highlighterColor)
      const cls = `isHighlighted hl-${state.ui.highlighterColor}`
      const cur = getCellHighlightColor(key)
      if (!cur) {
        cell.classList.remove('isHighlighted', ...HIGHLIGHT_COLORS.map((c) => `hl-${c.id}`))
      } else {
        cell.classList.add('isHighlighted')
        cell.classList.remove(...HIGHLIGHT_COLORS.filter((c) => c.id !== cur).map((c) => `hl-${c.id}`))
        cell.classList.add(`hl-${cur}`)
      }
    },
    { signal: highlighterClickDelegationAbort.signal }
  )

  syncHighlighterModeDom()
  syncNoteModeDom()
  bindNoteCanvasEvents()

  document.querySelector('#app')?.addEventListener(
    'input',
    (e) => {
      const input = e.target.closest('.cellOddsInput')
      if (!input) return
      const raceNo = Number(input.dataset.raceNo)
      const horseNo = Number(input.dataset.horseNo)
      const field = input.dataset.field
      if (!Number.isFinite(raceNo) || !Number.isFinite(horseNo) || (field !== 'win' && field !== 'place')) return
      setManualOddsValue(raceNo, horseNo, field, input.value)
    },
    { signal: hideWithdrawnClickDelegationAbort.signal }
  )

  const raceNoInput = document.querySelector('#raceNo')

  function bumpRaceNo(delta) {
    if (!raceNoInput) return
    const cur = Number(raceNoInput.value)
    const base = Number.isFinite(cur) && cur >= 1 ? cur : 1
    raceNoInput.value = String(base + delta)
    state.篩選.場次編號 = raceNoInput.value
    clampRaceNoForCurrentMeeting()
    raceNoInput.value = state.篩選.場次編號
    scheduleRefreshRaceSubtitle(0)
    syncHkjcWpLinkHref()
    resetScheduledLoadedKey()
    refreshLiveOddsTableQuiet()
  }

  document.querySelector('#btnRaceNoDown')?.addEventListener('click', () => bumpRaceNo(-1))
  document.querySelector('#btnRaceNoUp')?.addEventListener('click', () => bumpRaceNo(1))

  raceNoInput?.addEventListener('change', () => {
    state.篩選.場次編號 = String(raceNoInput.value)
    clampRaceNoForCurrentMeeting()
    raceNoInput.value = state.篩選.場次編號
    scheduleRefreshRaceSubtitle(0)
    syncHkjcWpLinkHref()
    resetScheduledLoadedKey()
    refreshLiveOddsTableQuiet()
  })

  document.querySelector('#raceDate')?.addEventListener('change', () => {
    state.篩選.賽馬日 = document.querySelector('#raceDate')?.value?.trim() ?? state.篩選.賽馬日
    resetScheduledLoadedKey()
    loadMeetingsForSelectedDate().catch((e) => showToast(String(e?.message ?? e)))
  })

  document.querySelector('#meetingSelect')?.addEventListener('change', (e) => {
    const v = e.target?.value
    if (!v) return
    state.篩選.會場代號 = v
    state.scheduled.targetRaceNos = []
    state.scheduled.viewRaceNo = null
    state.scheduled.viewJobsRaceNo = null
    clampRaceNoForCurrentMeeting()
    if (raceNoInput) raceNoInput.value = state.篩選.場次編號
    renderScheduleRacePickInDom()
    renderScheduleViewRacePickInDom()
    renderScheduleViewJobsRacePickInDom()
    const jobsHost = document.querySelector('#scheduleJobsHost')
    if (jobsHost) jobsHost.innerHTML = scheduleJobsTemplate(state.scheduled.jobs)
    const resultsHost = document.querySelector('#scheduledResultsHost')
    if (resultsHost) resultsHost.innerHTML = scheduledResultTableTemplate()
    scheduleRefreshRaceSubtitle(0)
    syncHkjcWpLinkHref()
    resetScheduledLoadedKey()
    refreshLiveOddsTableQuiet()
  })

  scheduleRefreshRaceSubtitle(0)
  syncHkjcWpLinkHref()
  syncLiveOnlyChrome()
  if (supabase) renderScheduleRacePickInDom()

  /** Re-apply tab visibility/pollers from state (handles restored 「預定」 tab after refresh). */
  setBottomTab(state.ui.bottomTab)
  if (state.ui.bottomTab === 'scheduled' && supabase) {
    loadScheduledData(true).catch((e) => showToast(String(e?.message ?? e)))
  }

  document.querySelector('#tabLiveBtn')?.addEventListener('click', () => {
    if (state.ui.bottomTab === 'live') return
    setBottomTab('live')
  })
  document.querySelector('#tabScheduledBtn')?.addEventListener('click', () => {
    if (state.ui.bottomTab === 'scheduled') return
    setBottomTab('scheduled')
    loadScheduledData(true).catch((e) => showToast(String(e?.message ?? e)))
  })

  document.querySelector('#btnRefresh')?.addEventListener('click', () => {
    try {
      if (!supabase) {
        showToast('未設定 Supabase')
        return
      }
      readFilterFromInputs()
      showToast('正在從馬會更新賽事列表…')
      loadMeetingsForSelectedDate({ resetScheduledTargets: false })
        .then(() => readFilterFromInputs())
        .then((filter) => {
          showToast('提取賠率中…')
          return runExtractNow(filter).then(() => loadLatestResults(filter))
        })
        .then((n) => {
          state.ui.bottomTab = 'live'
          mount()
          showToast(
            n
              ? `賽事列表已更新 · 已更新 ${n} 筆`
              : '賽事列表已更新。已提取但未取得獨贏/位置數值；請確認馬會頁面已有數字後再試。'
          )
        })
        .catch((e) => showToast(String(e?.message ?? e)))
    } catch (e) {
      showToast(String(e?.message ?? e))
    }
  })

  if (!state.ui.meetingsLoading) {
    refreshLiveOddsTableQuiet()
  }
}

runWithSiteGate(bootstrap)
