# pi-session-handoff

給 Pi 的 **session 交接與記憶分層** bundle：開工自動讀上次交接、收尾提醒寫交接、
用量達 50% 後等待作業結束再交接與壓縮、壓縮與退場前備份紀錄，並附三條指令
（`/wrap`、`/retro`、`/memory-defrag`）與一份技能。
概念取自 Claude Code 的 hooks 做法，實作改用 **Pi 擴充事件**（Pi 沒有 `hooks.json`）。

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
| 原始紀錄 | transcript 與交接快照 | `.pi/transcripts/`、`.pi/handoff-history/` | hook 自動存，勿入版控 |

交接檔固定八段、上限 80 行：目標／本次完成／進行中／下一步／已決定的事與理由／
死路／待我確認／驗證狀態。

## 提供的事件（Claude Code → Pi）

| 目的 | Claude Code | Pi 事件 | 行為 |
| --- | --- | --- | --- |
| 開工注入交接 | `SessionStart` | `before_agent_start` | 每 session 注入一次交接檔 |
| 收尾提醒 | `Stop` | `agent_before_settle` | 有未 commit 異動且交接檔逾時 → 擋一次 |
| 自動交接壓縮 | — | `turn_end`／`agent_settled` | 50% 時標記；作業結束後先寫交接、再壓縮並續作 |
| 壓縮前備份 | `PreCompact` | `session_before_compact` | 備份，不取消壓縮 |
| 退場備份 | `SessionEnd` | `session_shutdown` | 再備一份（Pi 此事件必觸發） |

## 指令

| 指令 | 用途 |
| --- | --- |
| `/handoff-init [agents] [force]` | 專案初始化：交接檔、設定檔、`.gitignore`、（可選）AGENTS.md 協定段 |
| `/handoff-status` | 交接檔健康度：存在與否、更新於、髒檔數、下一步第 1 項、設定來源 |
| `/handoff-snapshot` | 立刻備份 transcript 與交接檔（手動存檔點） |
| `/handoff-reload` | 重載 `.pi/handoff.json` 並重設注入旗標 |
| `/wrap [額外指示]` | 收尾：整份重寫交接檔 |
| `/retro [聚焦範圍]` | 只報本 session 實際阻礙，優先建議做檢查而非文字規則 |
| `/memory-defrag [agents|handoff|all]` | 合併重複、刪除過期、搬移模組專屬知識 |

## 設定（`.pi/handoff.json`）

讀取順序：內建預設 ← `.pi/handoff.json` ← `./handoff.json` ← 環境變數 `PI_HANDOFF_*`。

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `handoffPath` | `docs/HANDOFF.md` | 交接檔路徑（相對專案根） |
| `staleMinutes` | `120` | 超過即視為過舊 |
| `maxInjectChars` | `8000` | 注入 context 的上限 |
| `keepSnapshots` | `30` | 兩種快照各保留幾份 |
| `nagMode` | `"advisory"` | `advisory`／`block`＝要求續跑一次（Pi 無硬擋形態，兩者同行為）；`off`＝只印提醒。舊鍵 `nagOnSettle`（布林）仍相容，`nagMode` 存在時優先 |
| `injectOnStart` | `true` | 是否注入交接內容 |
| `autoHandoffCompact` | `true` | 啟用 50% 自動交接壓縮；`PI_HANDOFF_AUTO_COMPACT` 可覆寫 |
| `snapshotOnCompact` | `true` | 壓縮前備份 |
| `snapshotOnShutdown` | `true` | 退場前備份 |
| `verifyCommand` | `""` | 寫進提醒與 status 的驗證指令，例：`tools/run_tests.sh` |
| `protocolDoc` | `""` | 協定文件位置，例：`AGENTS.md §4` |
| `ignorePrefixes` | `[]` | 髒檔檢查額外忽略的前綴 |

髒檔檢查一律排除 `.pi/`、`.agents/` 與交接檔本身；不是 git repo 時自動跳過檢查。
`PI_HANDOFF_NAG` 之外也接受 omp 版的 `OMP_HANDOFF_NAG`，方便兩個 harness 一起降層。

### Pi 原生自動壓縮的後備門檻

建議將 Pi 原生自動壓縮設在約 80%，讓 50% 的交接流程有餘裕。Pi 使用固定 token 數，
不是百分比：在 `.pi/settings.json` 的 `compaction.modelOverrides`，為每個模型設定
`reserveTokens = context window × 0.2`。例如模型視窗為 100,000 tokens：

```json
{
  "compaction": {
    "enabled": true,
    "modelOverrides": {
      "example-provider/example-model": { "reserveTokens": 20000 }
    }
  }
}
```

將模型鍵替換為 Pi 的精確 `provider/modelId`。修改設定後重新啟動 Pi；未設定的模型仍使用
Pi 原有門檻。extension 不會改寫 Pi 設定。長時間工作、模型切換或大型工具輸出仍可能先觸發
原生壓縮；Pi 目前沒有原子式「閒置才壓縮」API，其他輸入或 extension 也可能在閒置檢查後競爭。
因此此流程是盡力避免中斷，不是硬性保證。
本倉庫已為目前預設模型 `llama.cpp/qwen3.8-flash-next-unsloth-ud-iq4_xs`（262,144 tokens）
設定 `reserveTokens: 52429`；其他模型需另外設定。


**跨 harness 並行的專案**（同一 repo 同時用 pi 與 omp）：共用設定鍵名與
`omp-session-handoff` 一致；`autoHandoffCompact` 是 Pi bundle 的獨立設定，omp 獨有的
`knowledge`、`exitConfirm` 本 bundle 會忽略。每個 harness 只準載入**一份**實作。

## 注意

- 退場 hook **只做檔案備份**，不會叫模型寫交接；自動中途交接與收尾 `/wrap` 是不同流程。
- `agent_before_settle` 的攔阻會讓 agent 多跑一輪，每個 session 最多一次。
- 快照目錄務必留在 `.gitignore`，否則每輪 session 都產生髒檔、讓收尾檢查失準。
- **同一個 harness 只準載入一份實作**：user 層 `pi install` 之外又在專案 `.pi/extensions/`
  放一份，會各注入一次交接、各擋一次收尾（實測過）。
- **中途改擴充檔會再注入一次**：Pi 熱重載擴充時 per-session 旗標歸零，同一 session
  會再注入一份交接、settle 也再擋一次。不是 bug；收尾前別改 hook 檔。
- **指令沒執行、模型開始自由回答** → 通常是**專案尚未信任**（未信任時 Pi 不載入擴充，
  slash 指令就變成一般文字丟給模型）。加 `--approve` 跑一次，或先在本專案信任 Pi。
  實測：`/handoff-status` 在未信任的 `/tmp` 專案回的是模型編的排查步驟，不是指令輸出。
- 卸載：`pi remove /Users/johnchen/AICode/pi-session-handoff`（`-l` 卸專案層級）。
  已建立的 `docs/HANDOFF.md`、`AGENTS.md` 段落不會被自動移除。

## 開發與驗證

```sh
node test/behaviour.cjs   # 26 項行為測試（jiti＋mock context，不打模型、不碰你的 repo）
node --test test/auto-handoff.cjs  # 50% 門檻、交接、壓縮、續作及失敗情境

# 端到端：找個暫存專案真的安裝並跑指令
mkdir -p /tmp/x && cd /tmp/x && git init -q .
pi install /Users/johnchen/AICode/pi-session-handoff -l
pi --approve --no-session --no-tools -p "/handoff-init agents"
pi --approve --no-session --no-tools -p "/handoff-status"
```

行為測試涵蓋既有注入、收尾提醒、快照及初始化；自動交接測試另涵蓋門檻、作業結束、
交接檔保護、壓縮後續作、原生壓縮競爭、停用、取消與失敗。

授權：MIT。
