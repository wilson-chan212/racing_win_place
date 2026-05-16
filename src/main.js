import './style.css'
import { runWithSiteGate } from './lib/siteGate.js'
import { assertSupabaseConfigured, supabase } from './lib/supabase.js'
import {
  buildHkjcWpOddsUrl,
  fetchMeetingsForCalendarDate,
  fetchRaceSubtitle
} from './lib/hkjcRaceMeta.js'

function hongKongDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
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
    /** Tap table cells to apply fixed light-yellow highlight */
    highlighterMode: false
  },
  scheduled: {
    draftTimes: [toDateTimeLocalValue(new Date(Date.now() + 5 * 60 * 1000))],
    /** Race numbers (1-based) that receive new 預定 jobs on save — multi-select */
    targetRaceNos: [],
    /** Race number (1-based) shown in 預定抄賠率 results table — single select */
    viewRaceNo: null,
    /** Race number (1-based) for 預約提取 job list — single select */
    viewJobsRaceNo: null,
    jobs: [],
    snapshots: [],
    loading: false,
    loadedKey: ''
  }
}

let rows = []
let scheduleDuePollTimer = null
let hideWithdrawnClickDelegationAbort = null
let highlighterClickDelegationAbort = null

const HIGHLIGHT_STORAGE_KEY = 'projectRace_cellHighlights'
/** Remember 即時／預定 tab so reload keeps the same Supabase-backed view. */
const BOTTOM_TAB_STORAGE_KEY = 'projectRace_bottomTab'

function getHighlightedKeys() {
  if (!getHighlightedKeys._cache) {
    try {
      const raw = localStorage.getItem(HIGHLIGHT_STORAGE_KEY)
      const arr = raw ? JSON.parse(raw) : []
      getHighlightedKeys._cache = new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : [])
    } catch {
      getHighlightedKeys._cache = new Set()
    }
  }
  return getHighlightedKeys._cache
}

function persistHighlightedKeys() {
  localStorage.setItem(HIGHLIGHT_STORAGE_KEY, JSON.stringify([...getHighlightedKeys()]))
}

function isCellHighlighted(key) {
  return getHighlightedKeys().has(key)
}

function toggleCellHighlight(key) {
  const set = getHighlightedKeys()
  if (set.has(key)) set.delete(key)
  else set.add(key)
  persistHighlightedKeys()
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

function highlightCellClassSuffix(key) {
  return isCellHighlighted(key) ? ' isHighlighted' : ''
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

function highlighterToggleButtonHtml() {
  const on = state.ui.highlighterMode
  return `<button type="button" class="ghostBtn toggleHighlighterBtn" aria-pressed="${on ? 'true' : 'false'}">${on ? '關閉熒光筆' : '熒光筆'}</button>`
}

function hkjcWpAndHideRowFragment(linkId) {
  const href = buildHkjcWpOddsUrl('ch', state.篩選.賽馬日, state.篩選.會場代號, state.篩選.場次編號)
  return `
        <a
          id="${linkId}"
          class="hkjcWpLink"
          href="${escapeHtml(href)}"
          target="_blank"
          rel="noopener noreferrer"
        >開啟馬會投注頁（對應目前選項）</a>
        ${highlighterToggleButtonHtml()}
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
}

function renderScheduleJobsListInDom() {
  const host = document.querySelector('#scheduleJobsHost')
  if (!host) return
  host.innerHTML = scheduleJobsTemplate(state.scheduled.jobs)
  bindScheduleJobListActions()
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
    <section class="scheduledPanel" aria-label="預定抄賠率">
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
    </section>
  `
}

function scheduleTimeInputTemplate(time, index) {
  const removeDisabled = state.scheduled.draftTimes.length <= 1 ? 'disabled' : ''
  return `
    <div class="scheduleTimeRow">
      <label class="field">
        <span class="fieldLabel">時間${index + 1}</span>
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
  const filtered = jobs.filter((job) => job.race_no === raceNo)
  if (!filtered.length) {
    return `<div class="scheduledEmpty">第${raceNo}場尚無預定提取。</div>`
  }

  return `
    <div class="scheduleJobList" aria-label="預定提取狀態">
      ${filtered.map((job) => `
        <div class="scheduleJobRow">
          <div>
            <strong>${escapeHtml(formatDateTime(job.scheduled_at))}</strong>
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

  return `
    <div class="scheduledTableBlock">
      <h3 class="scheduledTableRaceTitle">第${raceNo}場</h3>
      <div class="scheduledTableWrap" role="region" aria-label="預定抄賠率結果 第${raceNo}場">
      <table class="scheduledTable">
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
          <tr class="sectionRow"><th scope="row" colspan="${horses.length + 1}">獨贏</th></tr>
          ${completedJobs.map((job, index) => oddsRow(`時間${labelFromIndex(index)}(${formatMonthDayHm(job.scheduled_at)})`, job, 'win')).join('')}
          <tr class="sectionRow"><th scope="row" colspan="${horses.length + 1}">位置</th></tr>
          ${completedJobs.map((job, index) => oddsRow(`時間${labelFromIndex(index)}(${formatMonthDayHm(job.scheduled_at)})`, job, 'place')).join('')}
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
  const href = buildHkjcWpOddsUrl('ch', f.raceDate, f.meetingCode, f.raceNo)
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
  setRaceSubtitleText('載入中…')
  try {
    const text = await fetchRaceSubtitle(f.raceDate, f.meetingCode, f.raceNo)
    setRaceSubtitleText(text)
  } catch {
    setRaceSubtitleText(`第${f.raceNo}場 · ${f.raceDate} · 會場 ${f.meetingCode}`)
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
  const { data: jobs, error: jobsError } = await supabase
    .from('race_extraction_jobs')
    .select('id,race_date,meeting_code,race_no,scheduled_at,status,last_error,last_run_at,completed_at,created_at')
    .eq('race_date', scope.raceDate)
    .eq('meeting_code', scope.meetingCode)
    .order('race_no', { ascending: true })
    .order('scheduled_at', { ascending: true })

  if (jobsError) throw new Error(jobsError.message)

  const { data: snapshots, error: snapshotError } = await supabase
    .from('race_extraction_snapshots')
    .select('job_id,race_no,horse_no,horse_name,barrier,jockey_name,trainer_name,win,place,withdrawn,extracted_at')
    .eq('race_date', scope.raceDate)
    .eq('meeting_code', scope.meetingCode)
    .order('race_no', { ascending: true })
    .order('horse_no', { ascending: true })

  if (snapshotError) throw new Error(snapshotError.message)

  state.scheduled.jobs = jobs ?? []
  state.scheduled.snapshots = snapshots ?? []
  state.scheduled.loadedKey = key
  syncScheduledViewRaceForMeeting()
  state.scheduled.loading = false
  renderScheduledPanel()

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
      const date = new Date(time)
      if (Number.isNaN(date.getTime())) throw new Error('請填寫正確的預定時間')
      rowsToInsert.push({
        race_date: scope.raceDate,
        meeting_code: scope.meetingCode,
        race_no: raceNo,
        scheduled_at: date.toISOString(),
        status: 'pending'
      })
    }
  }

  const { error } = await supabase.from('race_extraction_jobs').insert(rowsToInsert)
  if (error) throw new Error(error.message)
  state.scheduled.draftTimes = [toDateTimeLocalValue(new Date(Date.now() + 5 * 60 * 1000))]
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
}

function toggleHighlighterMode() {
  state.ui.highlighterMode = !state.ui.highlighterMode
  syncHighlighterModeDom()
  showToast(state.ui.highlighterMode ? '熒光筆已開啟：點選表格格以標示' : '熒光筆已關閉')
}

function syncHighlighterToggleLabels() {
  const on = state.ui.highlighterMode
  document.querySelectorAll('.toggleHighlighterBtn').forEach((btn) => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.textContent = on ? '關閉熒光筆' : '熒光筆'
  })
}

function bindScheduledEvents() {
  document.querySelector('#btnAddScheduleTime')?.addEventListener('click', () => {
    const last = state.scheduled.draftTimes.at(-1)
    const base = last ? new Date(last) : new Date()
    const next = Number.isNaN(base.getTime()) ? new Date(Date.now() + 5 * 60 * 1000) : new Date(base.getTime() + 5 * 60 * 1000)
    state.scheduled.draftTimes.push(toDateTimeLocalValue(next))
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
  await loadMeetingsForSelectedDate()
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

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toDateTimeLocalValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function formatMonthDayHm(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}月${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
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
      if (!state.ui.highlighterMode) return
      const cell = e.target.closest('[data-highlight-key]')
      if (!cell) return
      const key = cell.dataset.highlightKey
      if (!key) return
      toggleCellHighlight(key)
      cell.classList.toggle('isHighlighted', isCellHighlighted(key))
    },
    { signal: highlighterClickDelegationAbort.signal }
  )

  syncHighlighterModeDom()

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
    loadScheduledData().catch((e) => showToast(String(e?.message ?? e)))
  }

  document.querySelector('#tabLiveBtn')?.addEventListener('click', () => {
    if (state.ui.bottomTab === 'live') return
    setBottomTab('live')
  })
  document.querySelector('#tabScheduledBtn')?.addEventListener('click', () => {
    if (state.ui.bottomTab === 'scheduled') return
    setBottomTab('scheduled')
    loadScheduledData().catch((e) => showToast(String(e?.message ?? e)))
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
