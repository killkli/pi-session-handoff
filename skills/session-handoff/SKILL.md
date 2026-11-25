---
name: session-handoff
description: Session 開工／收尾協定：交接檔（預設 docs/HANDOFF.md）八段格式、AGENTS.md 分層知識、.pi/transcripts 備份規則，以及 /handoff-init、/wrap、/retro、/memory-defrag 的用法與 .pi/handoff.json 設定。當使用者說「收尾」「交接」「做到哪了」「下一個 session」「回顧踩坑」「整理記憶」，或 session 剛開工要接續前一輪狀態時使用。
---

# Session 開工／收尾協定

由 `pi-session-handoff` bundle 提供。三層分開擺，不混在同一個記憶檔裡：

| 層 | 放什麼 | 檔案 | 更新方式 |
| --- | --- | --- | --- |
| 交接狀態 | 做到哪、下一步、卡在哪、死路 | `docs/HANDOFF.md`（可用 `handoffPath` 覆寫） | 每次收尾**整份重寫**（不追加） |
| 專案知識 | 不明顯的坑、慣例、指令 | `AGENTS.md`（根目錄＝全專案；子目錄＝該模組專屬） | 學到新坑才補；能被自動化檢查取代的就別寫 |
| 原始紀錄 | transcript 與交接快照 | `.pi/transcripts/`、`.pi/handoff-history/` | hook 自動存，本機產物不入版控 |

分開放的理由：交接檔有固定格式，agent 知道去哪找；session 狀態每次都會整個改變，
需要整份重寫而是一直追加會變雜訊；內建記憶（`AGENTS.md`）適合放偏好與專案層級事實，
不適合放 session 狀態。專案知識要離相關程式碼越近越好：Pi 會自動載入工作目錄與其上層的
`AGENTS.md`，所以全專案適用的寫在根目錄，模組專屬的寫在該模組目錄。

## 新專案第一次（安裝後只做一次）

```
/handoff-init            # 建立交接檔＋.pi/handoff.json，並補 .gitignore
/handoff-init agents     # 同上，另把協定段附加到 AGENTS.md
```

已存在的檔案不會被覆寫；要覆寫加 `force`。之後 `/handoff-status` 看健康度。

## 開工 SOP

1. 讀交接檔（hook 會在每個 session 的第一則提示前自動注入）。
2. 先向使用者確認「下一步」第 1 項是否仍是現在要做的事，再動手。
3. 工作中做出的決策就地記進「已決定的事與理由」，不要只留在對話裡。

## 收尾 SOP（有產出就要做，不要攢到最後）

1. 跑 `/wrap` 整份重寫交接檔，格式見 `references/handoff-template.md`，上限 80 行。
2. 依本專案的 commit 規範自檢並提交；交接檔若要入版控，獨立一筆 `docs:` commit。
3. 本 session 踩到坑才跑 `/retro`：只報實際阻礙，**能自動檢查的就做檢查，不要寫成文字規則**。
4. 記憶檔開始變雜訊時跑 `/memory-defrag`（建議每月一次）。

## Pi 事件對應表

| 目的 | Claude Code 事件 | Pi 事件 | 行為 |
| --- | --- | --- | --- |
| 開工注入交接 | `SessionStart` | `before_agent_start` | 每個 session 注入一次交接檔（上限 `maxInjectChars`） |
| 收尾提醒 | `Stop` | `agent_before_settle` | 有未 commit 異動且交接檔逾時 → 擋一次 |
| 壓縮前備份 | `PreCompact` | `session_before_compact` | 備份 transcript＋交接快照，不取消壓縮 |
| 退場備份 | `SessionEnd` | `session_shutdown` | 同上（涵蓋 quit/new/resume/fork/reload） |

指令：`/handoff-init`、`/handoff-status`、`/handoff-snapshot`（手動存檔點）、
`/handoff-reload`（重載設定並重設注入旗標）。

## 設定（`.pi/handoff.json`）

`handoffPath`、`staleMinutes`（預設 120）、`maxInjectChars`（8000）、`keepSnapshots`（30）、
`nagOnSettle`（true＝真的要求續跑一次；false＝只印提醒）、`injectOnStart`、
`snapshotOnCompact`、`snapshotOnShutdown`、`verifyCommand`（寫進提醒與 status）、
`protocolDoc`、`ignorePrefixes`（髒檔檢查額外忽略）。
環境變數 `PI_HANDOFF_*` 優先級最高；改完跑 `/handoff-reload`。

## 四個坑

- **退場時不準叫模型寫交接**：`session_shutdown` 只做檔案備份；要寫交接請在結束前跑 `/wrap`。
- **`agent_before_settle` 回傳 `continue: true` 會真的多跑一輪**：每個 session 只提出一次，
  而且要「有髒檔」與「交接檔逾時」同時成立才觸發；嫌煩就把 `nagOnSettle` 改成 `false`
  或拉高 `staleMinutes`。
- **重複注入**：`/reload`、`/resume` 不會重複注入——會比對分支上既有注入訊息的時間戳與交接檔 mtime。
- **快照目錄不要入版控**：`.pi/transcripts/`、`.pi/handoff-history/` 要留在 `.gitignore`
  （`/handoff-init` 會自動補），否則每輪 session 都會產生髒檔、讓收尾檢查失準。
