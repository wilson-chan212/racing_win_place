# Project Race（賽事賠率）

用 **Capacitor (iOS/Android)** 包裝的手機 App（前端：JavaScript/HTML/CSS），透過 **Supabase Edge Function** 從 HKJC 賽事賠率頁面提取每匹馬的 **獨贏 / 位置**，儲存到 Supabase，並在 App UI 顯示。

## 1) 本機啟動（Web UI）

```bash
npm install
cp .env.example .env
```

在 `.env` 填入：
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

啟動：

```bash
npm run dev
```

## 2) Supabase 資料表（SQL）

在 Supabase SQL Editor 執行：
- `supabase/migrations/001_create_race_results.sql`

會建立：
- `public.race_results`
- `public.race_extraction_jobs`

以及 RLS 的讀取 policy（`authenticated` 可讀）。

## 3) Edge Function（提取 HKJC）

Edge Function 檔案：
- `supabase/functions/extract-race-results/index.ts`
- `supabase/functions/process-scheduled-extractions/index.ts`

部署方式（其中一種）：
1. 安裝 Supabase CLI
2. 連接你的 Supabase project
3. `supabase functions deploy extract-race-results`
4. `supabase functions deploy process-scheduled-extractions`

Edge Function 需要環境變數（Supabase CLI 不允許 `SUPABASE_*` 開頭，所以用 `PROJECT_*`）：
- `PROJECT_SUPABASE_URL`
- `PROJECT_SERVICE_ROLE_KEY`
- `PROJECT_SUPABASE_ANON_KEY`（用來辨識匿名使用者）
- `SCHEDULE_PROCESSOR_SECRET`（只供排程 processor 使用）

呼叫格式（App 會用 `supabase.functions.invoke` 呼叫）：

```json
{
  "raceDate": "2026-05-10",
  "meetingCode": "S2",
  "raceNo": 4
}
```

HKJC URL 會依參數組合：
`https://bet.hkjc.com/en/racing/wp/{raceDate}/{meetingCode}/{raceNo}`

### 預定抄賠率排程

App 會把使用者設定的預定時間寫入 `public.race_extraction_jobs`。到期後由 **伺服器 pg_cron** 每分鐘呼叫 `process-user-due-extractions`（**無需開著網頁**），**直接向馬會提取**並只寫入：
- `public.race_extraction_snapshots`：每個預定時間的歷史快照（與 `race_results` 即時賠率分開）

**一次性設定（遠端 Supabase）：**

1. 執行 migration `008_schedule_processor_cron.sql`（`supabase db push` 或 SQL Editor）
2. 在 SQL Editor 執行 `supabase/setup-cron-vault.sql`，填入你的 Project URL 與 anon key
3. 部署 Edge Functions：`process-user-due-extractions`（及 `extract-race-results`）

驗證 cron：`select jobid, jobname, schedule, active from cron.job where jobname = 'race-process-due-extractions';`

（可選）外部 cron 亦可 POST `process-scheduled-extractions`，Header：`x-schedule-secret: <SCHEDULE_PROCESSOR_SECRET>`

## 4) Capacitor（Android / iOS）

同步 Web build 到原生專案：

```bash
npm run cap:sync
```

打開原生專案：

```bash
npm run cap:open:android
npm run cap:open:ios
```

注意：在 Windows 上可以建立 `ios/` 專案，但要編譯/上架 iOS 需要 macOS + Xcode。

## 5) UI（中文）

UI 依照你提供的截圖設計：頂部藍色 App Bar、賠率分頁、下方表格顯示每匹馬的獨贏/位置。  
「預定抄賠率」分頁可新增多個提取時間，完成後會以馬號為欄、提取時間為列顯示獨贏 / 位置歷史結果。

## 6) 不用登入，但每個人只看到自己的結果（Anonymous Auth）

本專案使用 Supabase **Anonymous sign-ins**：
- 使用者不需要手動登入
- App 會在第一次開啟時自動建立匿名 session（得到 `auth.uid()`）
- RLS 會限制：只能讀取 `created_by = auth.uid()` 的資料

你需要在 Supabase Dashboard：
1. Authentication → Providers → 啟用 **Anonymous sign-ins**
2. 然後執行 `supabase/migrations/002_add_ownership_and_rls.sql`
