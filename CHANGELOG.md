# Changelog

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
