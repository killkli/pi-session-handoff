# pi-session-handoff

給 Pi 的 **session 交接與記憶分層** bundle：交接、讀取與快照均由使用者手動執行，
並附 `/wrap`、`/retro`、`/memory-defrag` 指令與一份技能。壓縮使用 Pi 內建 `/compact`。
此 extension 不註冊自動 session 事件。

一句話：**交接狀態、專案知識、原始紀錄三層分開擺**，session 狀態就不會淹掉長期知識。

## 安裝

```sh
# 個人層級（所有專案可用，寫入 ~/.pi/agent/settings.json）
pi install /Users/johnchen/AICode/pi-session-handoff
# 或從 git（推上 GitHub 後）
pi install git:github.com/<you>/pi-session-handoff

# 只裝在單一專案（寫入該專案 .pi/settings.json）
cd /path/to/project && pi install /Users/johnchen/AICode/pi-session-handoff -l
```

試載不寫設定（單次）：`pi -e /Users/johnchen/AICode/pi-session-handoff`

## 每個專案只做一次

```
/handoff-init            # 建立 docs/HANDOFF.md ＋ .pi/handoff.json，並補 .gitignore
/handoff-init agents     # 同上，另把協定段附加到 AGENTS.md
```

已存在的檔案不覆寫（要覆寫加 `force`）。之後就照開工／收尾節奏走。

## 三層存放

| 層 | 放什麼 | 檔案 | 更新方式 |
| --- | --- | --- | --- |
| 交接狀態 | 做到哪、下一步、卡在哪、死路 | `docs/HANDOFF.md` | 每次收尾**整份重寫** |
| 專案知識 | 不明顯的坑、慣例、指令 | `AGENTS.md`（可分層放子目錄） | 學到新坑才補 |
| 原始紀錄 | transcript 與交接快照 | `.pi/transcripts/`、`.pi/handoff-history/` | 手動快照，勿入版控 |

交接檔固定八段、上限 80 行：目標／本次完成／進行中／下一步／已決定的事與理由／
死路／待我確認／驗證狀態。

## 手動操作

本 extension 不會自動注入交接、提醒收尾、備份或壓縮。需要時使用以下指令。

## 指令

| 指令 | 用途 |
| --- | --- |
| `/handoff-init [agents] [force]` | 專案初始化：交接檔、設定檔、`.gitignore`、（可選）AGENTS.md 協定段 |
| `/handoff-status` | 交接檔健康度：存在與否、更新於、髒檔數、下一步第 1 項、設定來源 |
| `/handoff-read` | 手動讀取交接內容，提供給下一輪提示 |
| `/handoff-snapshot` | 立刻備份 transcript 與交接檔（手動存檔點） |
| `/handoff-reload` | 重載 `.pi/handoff.json` |
| `/wrap [額外指示]` | 收尾：整份重寫交接檔 |
| `/compact [指示]` | Pi 內建的手動壓縮指令 |
| `/retro [聚焦範圍]` | 只報本 session 實際阻礙，優先建議做檢查而非文字規則 |
| `/memory-defrag [agents|handoff|all]` | 合併重複、刪除過期、搬移模組專屬知識 |

## 設定（`.pi/handoff.json`）

讀取順序：內建預設 ← `.pi/handoff.json` ← `./handoff.json` ← 環境變數 `PI_HANDOFF_*`。

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `handoffPath` | `docs/HANDOFF.md` | 交接檔路徑（相對專案根） |
| `staleMinutes` | `120` | 超過即視為過舊 |
| `maxInjectChars` | `8000` | 手動讀取交接內容的上限 |
| `keepSnapshots` | `30` | 兩種快照各保留幾份 |
| `verifyCommand` | `""` | status 顯示的驗證指令，例：`tools/run_tests.sh` |
| `ignorePrefixes` | `[]` | 髒檔檢查額外忽略的前綴 |

髒檔檢查一律排除 `.pi/`、`.agents/` 與交接檔本身；不是 git repo 時自動跳過檢查。

### 手動壓縮

此 extension 不會因 context 用量而自動寫交接、壓縮或續作。先手動執行 `/wrap`，
再執行 Pi 內建的 `/compact`。若要避免 Pi 本身自動壓縮，在 Pi 使用者設定
`~/.pi/agent/settings.json` 的 `compaction` 設為 `{ "enabled": false }`；
手動 `/compact` 仍可使用。專案設定若另有覆寫，請一併檢查。

停用自動壓縮後，context 耗盡時工作可能失敗；請自行留意用量並及時手動壓縮。


**跨 harness 並行的專案**：各自使用各自的設定檔。

## 注意

- 快照由 `/handoff-snapshot` 手動建立；快照目錄務必留在 `.gitignore`。
- **指令沒執行、模型開始自由回答** → 通常是**專案尚未信任**（未信任時 Pi 不載入擴充，
  slash 指令就變成一般文字丟給模型）。加 `--approve` 跑一次，或先在本專案信任 Pi。
  實測：`/handoff-status` 在未信任的 `/tmp` 專案回的是模型編的排查步驟，不是指令輸出。
- 卸載：`pi remove /Users/johnchen/AICode/pi-session-handoff`（`-l` 卸專案層級）。
  已建立的 `docs/HANDOFF.md`、`AGENTS.md` 段落不會被自動移除。

## 開發與驗證

```sh
node test/behaviour.cjs   # 行為測試（jiti＋mock context，不打模型、不碰你的 repo）

# 端到端：找個暫存專案真的安裝並跑指令
mkdir -p /tmp/x && cd /tmp/x && git init -q .
pi install /Users/johnchen/AICode/pi-session-handoff -l
pi --approve --no-session --no-tools -p "/handoff-init agents"
pi --approve --no-session --no-tools -p "/handoff-status"
```

行為測試涵蓋初始化、手動讀取與快照，以及高用量時不自動交接或壓縮。

授權：MIT。
