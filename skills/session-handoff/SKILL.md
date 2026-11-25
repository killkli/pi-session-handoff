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
| 中途自動交接 | — | `turn_end`／`agent_settled` | 50% 標記，等作業結束後寫交接、壓縮並自動接續；不取代 `/wrap` |
| 壓縮前備份 | `PreCompact` | `session_before_compact` | 備份 transcript＋交接快照，不取消壓縮 |
| 退場備份 | `SessionEnd` | `session_shutdown` | 同上（涵蓋 quit/new/resume/fork/reload） |

指令：`/handoff-init`、`/handoff-status`、`/handoff-snapshot`（手動存檔點）、
`/handoff-reload`（重載設定並重設注入旗標）。

## 設定（`.pi/handoff.json`）

`handoffPath`、`staleMinutes`（預設 120）、`maxInjectChars`（8000）、`keepSnapshots`（30）、
`nagMode`（`advisory`／`block`＝要求續跑一次，`off`＝只印提醒；舊鍵 `nagOnSettle`
布林仍相容，`nagMode` 存在時優先）、`injectOnStart`、
`autoHandoffCompact`（預設 `true`，50% 門檻）、`snapshotOnCompact`、`snapshotOnShutdown`、
`verifyCommand`（寫進提醒與 status）、`protocolDoc`、`ignorePrefixes`（髒檔檢查額外忽略）。
環境變數 `PI_HANDOFF_*`（含 omp 版的 `OMP_HANDOFF_NAG`）優先級最高；改完跑 `/handoff-reload`。
長跑素材生成／QA 採證的專案建議把 `staleMinutes` 從 120 拉到 240，否則正常施工中就會誤報。
Pi 原生自動壓縮以模型的 `contextWindow × 0.2` 設定 `compaction.modelOverrides` 的
`reserveTokens`，可約在 80% 觸發；設定與重啟方式見 README。此 extension 不修改 Pi 設定；
原生壓縮可能在長作業中先觸發，且 Pi 的閒置檢查與壓縮並非原子操作。
**與 omp 並行的專案**：共用設定鍵名一致；`autoHandoffCompact` 僅供 Pi bundle 使用，
omp 獨有的 `knowledge`、`exitConfirm` 在 Pi 端被忽略。

## 七個坑

- **退場時不準叫模型寫交接**：`session_shutdown` 只做檔案備份；要寫交接請在結束前跑 `/wrap`。
- **`agent_before_settle` 回傳 `continue: true` 會真的多跑一輪**：每個 session 只提出一次，
  而且要「有髒檔」與「交接檔逾時」同時成立才觸發；嫌煩就把 `nagMode` 改成 `"off"`
  （只印提醒）或拉高 `staleMinutes`。
- **重複注入有三種來源**：(1) `/reload`、`/resume` 不會重複——會比對分支上既有注入訊息的
  時間戳與交接檔 mtime；(2) **同一 harness 載入兩份實作**（user 層 `pi install` 之外又在專案
  `.pi/extensions/` 放一份）會各注入一次、各擋一次，一個 harness 只準一份；
  (3) **中途改擴充檔**觸發熱重載，per-session 旗標歸零，同 session 會再注入一次、settle
  再擋一次（實測）。收尾前別改 hook 檔；看到了認得出來就好。
- **指令沒反應、模型開始自由回答**：通常是**專案未信任**，Pi 不載入擴充，slash 指令淪為
  一般文字丟給模型（實測 `/handoff-status` 回的是模型編的排查步驟）。先加 `--approve`
  跑一次或把專案加入信任清單，再來查 bundle 有沒有裝錯層級。
- **快照目錄不要入版控**：`.pi/transcripts/`、`.pi/handoff-history/` 要留在 `.gitignore`
  （`/handoff-init` 會自動補），否則每輪 session 都會產生髒檔、讓收尾檢查失準。
