import { createClient } from '@supabase/supabase-js'

function readViteEnv(name) {
  const v = import.meta.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

const url = readViteEnv('VITE_SUPABASE_URL')
const anonKey = readViteEnv('VITE_SUPABASE_ANON_KEY')

/** True when vars look like unedited .env.example (treated as "not configured"). */
function isPlaceholderConfig(u, k) {
  return u.includes('your-project-ref') || k === 'your-supabase-anon-key'
}

const configured = Boolean(url && anonKey && !isPlaceholderConfig(url, anonKey))

export const supabase = configured ? createClient(url, anonKey) : null

export function assertSupabaseConfigured() {
  if (!supabase) {
    throw new Error(
      'Supabase 未設定：在專案根目錄建立 .env，設定 VITE_SUPABASE_URL 與 VITE_SUPABASE_ANON_KEY（須以 VITE_ 開頭；變更後請重啟 dev server）'
    )
  }
}
