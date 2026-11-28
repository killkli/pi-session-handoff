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
| 原始紀錄 | transcript 與交接快照 | `.pi/transcripts/`、`.pi/handoff-history/` | 手動快照，本機產物不入版控 |

分開放的理由：交接檔有固定格式，agent 知道去哪找；session 狀態每次都會整個改變，
需要整份重寫而是一直追加會變雜訊；內建記憶（`AGENTS.md`）適合放偏好與專案層級事實，
不適合放 session 狀態。專案知識要離相關程式碼越近越好：Pi 會自動載入工作目錄與其上層的
`AGENTS.md`，所以全專案適用的寫在根目錄，模組專屬的寫在該模組目錄。

## 新專案第一次（安裝後只做一次）

```
/handoff-init            # 建立交接檔＋.pi/handoff.json，並補 .gitignore
/handoff-init agents     # 同上，另把協定段附加到 AGENTS.md
```

已存在的交接檔不會被覆寫；要覆寫專案內的交接檔可加 `force`，設定不會重設。之後以 `/handoff-status` 查看健康度與實際路徑。

## 開工 SOP

1. 使用者要求時以 `/handoff-read` 讀交接檔。
2. 先向使用者確認「下一步」第 1 項是否仍是現在要做的事，再動手。
3. 工作中的決策留在 session；只有使用者要求交接時才更新交接檔。

## 收尾 SOP（僅在使用者要求時）

1. 跑 `/wrap` 整份重寫交接檔，格式見 `references/handoff-template.md`，上限 80 行。
2. 依本專案的 commit 規範自檢並提交；交接檔若要入版控，獨立一筆 `docs:` commit。
3. 本 session 踩到坑才跑 `/retro`：只報實際阻礙，**能自動檢查的就做檢查，不要寫成文字規則**。
4. 記憶檔開始變雜訊時跑 `/memory-defrag`（建議每月一次）。

## 手動指令

extension 不註冊自動 session 事件。使用者可呼叫 `/handoff-init`、
`/handoff-status`、`/handoff-read`、`/handoff-snapshot` 或 `/handoff-reload`。

## 設定（`.pi/handoff.json`）

`handoffPath`、`staleMinutes`（預設 120）、`maxInjectChars`（8000）、`keepSnapshots`（30）、
`verifyCommand`（status 顯示的驗證指令）及 `ignorePrefixes`（髒檔檢查額外忽略）。
各欄位的優先順序（由低到高）：預設值 → `.pi/handoff.json` → `./handoff.json` → `PI_HANDOFF_*`。
每次手動指令都讀取最新設定；可用 `/handoff-reload` 檢查格式錯誤。
交接與壓縮請手動執行 `/wrap` 與 `/compact`；Pi 原生自動壓縮可在使用者設定中以
`compaction.enabled: false` 停用。停用後應留意 context 用量，避免耗盡。

## 注意

- 交接與快照不會在退場時自動產生；使用者可分別執行 `/wrap` 和 `/handoff-snapshot`。
- **未信任專案不讀寫交接資料**。Pi 不載入未信任的專案層級套件；即使套件由個人層級載入，指令也會檢查信任。只對已審閱的專案使用 `--approve` 或加入信任清單。
- **快照可能包含敏感資料，不入版控**：`.pi/transcripts/`、`.pi/handoff-history/` 要留在 `.gitignore`
  （`/handoff-init` 會補上）；`.gitignore` 不會移除已追蹤的檔案。
