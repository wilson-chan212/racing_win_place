const STORAGE_KEY = 'projectRace_siteUnlock'

function readViteEnv(name) {
  const v = import.meta.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

export function getSitePassword() {
  return readViteEnv('VITE_SITE_PASSWORD')
}

function unlockToken(password) {
  let h = 5381
  for (let i = 0; i < password.length; i++) {
    h = ((h << 5) + h) ^ password.charCodeAt(i)
  }
  return `u${(h >>> 0).toString(36)}`
}

export function isSiteGateRequired() {
  return Boolean(getSitePassword())
}

export function isSiteUnlocked() {
  const expected = getSitePassword()
  if (!expected) return true
  try {
    return sessionStorage.getItem(STORAGE_KEY) === unlockToken(expected)
  } catch {
    return false
  }
}

function persistUnlock() {
  const expected = getSitePassword()
  if (!expected) return
  try {
    sessionStorage.setItem(STORAGE_KEY, unlockToken(expected))
  } catch {
    // private mode / blocked storage
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

function renderGate(errorMessage) {
  const host = document.querySelector('#app')
  if (!host) return
  host.innerHTML = `
    <section class="siteGate" role="dialog" aria-labelledby="siteGateTitle">
      <div class="siteGateCard">
        <h1 class="siteGateTitle" id="siteGateTitle">賽事賠率</h1>
        <p class="siteGateLead">請輸入此頁面的簡易存取密碼。</p>
        <form class="siteGateForm" id="siteGateForm" autocomplete="off">
          <label class="field" for="siteGatePassword">
            <span class="fieldLabel">存取密碼</span>
            <input
              id="siteGatePassword"
              name="password"
              type="password"
              inputmode="text"
              autocomplete="current-password"
              required
              autofocus
            />
          </label>
          ${
            errorMessage
              ? `<p class="siteGateError" role="alert">${escapeHtml(errorMessage)}</p>`
              : ''
          }
          <button type="submit" class="primaryBtn siteGateSubmit">進入</button>
        </form>
      </div>
    </section>
  `
}

function bindGateForm(onSuccess) {
  const form = document.querySelector('#siteGateForm')
  const input = document.querySelector('#siteGatePassword')
  if (!form || !input) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const entered = input.value
    if (entered === getSitePassword()) {
      persistUnlock()
      onSuccess()
      return
    }
    renderGate('密碼不正確，請再試一次。')
    bindGateForm(onSuccess)
    document.querySelector('#siteGatePassword')?.focus()
  })
}

function showGate() {
  return new Promise((resolve) => {
    renderGate('')
    bindGateForm(resolve)
    document.querySelector('#siteGatePassword')?.focus()
  })
}

/** Run `startApp` only after site password gate (if VITE_SITE_PASSWORD is set). */
export async function runWithSiteGate(startApp) {
  if (!isSiteGateRequired() || isSiteUnlocked()) {
    await startApp()
    return
  }
  await showGate()
  await startApp()
}
