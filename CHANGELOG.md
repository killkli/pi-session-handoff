# Changelog

## 未發行

- 移除 50% 自動交接、壓縮及續作流程與相關設定；交接及壓縮改為手動。
- 移除所有自動 session 事件及其設定；新增 `/handoff-read`，交接讀取和快照也由使用者手動執行。

## 1.1.0 - 2026-11-25

來自 taiwan-homm3-like 的第二輪：同一倉庫由 pi 與 omp 兩個 agent 並行時，
兩套 bundle 的設定鍵名不同（`nagOnSettle` 布林 vs `nagMode` 三態），
同一份門檻要寫兩種格式，結果一邊永遠過舊、另一邊從不提醒。

- `nagMode`（`advisory`／`block`／`off`）成為正式鍵，**與 omp 版同名同義**；
  舊鍵 `nagOnSettle`（布林）繼續相容，`nagMode` 存在時優先。
- 環境變數多接受 `OMP_HANDOFF_NAG`，讓兩個 harness 一起降層。
- `/handoff-status` 顯示 `nag=<mode>`；`/handoff-init` 的種子設定改寫 `nagMode`。
- README／技能補兩條實測坑：同一 harness 載入兩份實作會重複注入與重複攔阻；
  中途改擴充檔觸發熱重載，會讓 per-session 旗標歸零而再注入一次。
- 行為測項 23 → 26（新增 `nagMode` 三態與優先序）。
- 文件補記兩個環境坑：同一 harness 載入兩份實作會重複注入／重複攔阻；專案未信任時
  Pi 不載入擴充，slash 指令會變成模型自由回答（不是 bundle 壞掉）。

## 1.0.0 - 2026-11-25

首版：把 taiwan-homm3-like 專案內驗證過的 session 交接協定抽成通用 bundle。

- `extensions/session-handoff.ts`：四個 Pi 擴充事件
  （`before_agent_start` 注入交接、`agent_before_settle` 收尾擋一次、
  `session_before_compact`／`session_shutdown` 備份 transcript 與交接快照）＋
  `/handoff-init`、`/handoff-status`、`/handoff-snapshot`、`/handoff-reload`。
- `prompts/`：`/wrap`（整份重寫交接檔）、`/retro`（實際阻礙萃取）、`/memory-defrag`（記憶整理）。
- `skills/session-handoff/`：協定、SOP、事件對應表、設定表與四個坑。
- 設定改由地緣檔案驅動：`.pi/handoff.json` ← `./handoff.json` ← `PI_HANDOFF_*`，
  不再把驗證指令、協定文件位置寫死在碼裡。

行為測項（jiti＋mock context）：註冊 5 事件／4 指令；注入每 session 僅 1 次；
`/resume`、`/reload` 不重複注入；`messageType: "custom"` 不注入；逾時才擋且僅擋 1 次；
非 git repo 不檢查；髒檔檢查排除 `.pi/`、`.agents/`；壓縮與退場各備一份；
`/handoff-init` 冪等（已存在不覆寫、`force` 才覆寫、`.gitignore` 只補一次）。
