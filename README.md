# pi-session-handoff

給 Pi 的 **session 交接與記憶分層** bundle：交接、讀取與快照均由使用者手動執行，
並附 `/wrap`、`/retro`、`/memory-defrag` 指令與一份技能。壓縮使用 Pi 內建 `/compact`。
此 extension 不註冊自動 session 事件。

一句話：**交接狀態、專案知識、原始紀錄三層分開擺**，session 狀態就不會淹掉長期知識。

## 安裝

已用 Pi 1.6.1 驗證。從 Git 安裝：

```sh
# 個人層級（寫入 ~/.pi/agent/settings.json）
pi install git:github.com/killkli/pi-session-handoff

# 或只裝在目前專案（寫入 .pi/settings.json）
pi install git:github.com/killkli/pi-session-handoff -l
```

也可指定本機 clone 的絕對路徑，例如 `pi install /path/to/pi-session-handoff`。
單次試載、不寫設定：`pi -e /path/to/pi-session-handoff`。

## 每個專案只做一次

```
/handoff-init            # 建立交接檔（預設 docs/HANDOFF.md）、.pi/handoff.json，並補 .gitignore
/handoff-init agents     # 同上，另把協定段附加到 AGENTS.md
```

可重複執行。`force` 只覆寫專案內的交接檔，不重設既有設定，也不覆寫 `.gitignore` 或 `AGENTS.md` 的既有內容。專案外的交接檔需手動建立。

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
| `/handoff-reload` | 重新讀取並檢查設定來源與格式 |
| `/wrap [額外指示]` | 收尾：整份重寫交接檔 |
| `/compact [指示]` | Pi 內建的手動壓縮指令 |
| `/retro [聚焦範圍]` | 只報本 session 實際阻礙，優先建議做檢查而非文字規則 |
| `/memory-defrag [agents|handoff|all]` | 合併重複、刪除過期、搬移模組專屬知識 |

## 設定（`.pi/handoff.json`）

優先順序（由低到高）：內建預設 → `.pi/handoff.json` → `./handoff.json` → `PI_HANDOFF_*`。
每個欄位各自覆蓋；未填或格式錯誤的欄位保留上一層值。每次手動執行都會讀取最新設定，不必先跑 `/handoff-reload`；`/handoff-status` 和 `/handoff-reload` 會顯示設定警告。

| 欄位 | 預設 | 環境變數 | 說明 |
| --- | --- | --- | --- |
| `handoffPath` | `docs/HANDOFF.md` | `PI_HANDOFF_PATH` | 相對於 Pi 工作目錄，亦可指定絕對路徑 |
| `staleMinutes` | `120` | `PI_HANDOFF_STALE_MINUTES` | 非負數，超過即視為過舊 |
| `maxInjectChars` | `8000` | `PI_HANDOFF_MAX_INJECT_CHARS` | 手動讀取上限（UTF-16 碼元）；`0` 不提供交接內容 |
| `keepSnapshots` | `30` | `PI_HANDOFF_KEEP_SNAPSHOTS` | 兩種快照各自保留的份數；`0` 不新建也不刪除 |
| `verifyCommand` | `""` | `PI_HANDOFF_VERIFY_COMMAND` | 例如 `npm test`；extension 只顯示、不執行 |
| `ignorePrefixes` | `[]` | — | Git 狀態額外忽略的路徑前綴，相對於 Pi 工作目錄 |

`/handoff-status` 統計整個 Git 工作樹；排除 `.pi/`、`.agents/` 和交接檔的確切路徑。重新命名只計一筆，且兩端都屬於忽略路徑時才排除。非 Git 儲存庫或 Git 失敗時顯示「未檢查」。

### 手動壓縮

此 extension 不會因 context 用量而自動寫交接、壓縮或續作。先手動執行 `/wrap`，
再執行 Pi 內建的 `/compact`。若要避免 Pi 本身自動壓縮，在 Pi 使用者設定
`~/.pi/agent/settings.json` 的 `compaction` 設為 `{ "enabled": false }`；
手動 `/compact` 仍可使用。專案設定若另有覆寫，請一併檢查。

停用自動壓縮後，context 耗盡時工作可能失敗；請自行留意用量並及時手動壓縮。


**跨 harness 並行的專案**：各自使用各自的設定檔。

## 注意

- 快照可能包含原始提示、程式碼、指令輸出與憑證。先跑 `/handoff-init` 補上忽略規則，不要上傳或提交快照；`.gitignore` 不會移除已追蹤的檔案。新快照在支援 Unix 權限的檔案系統上只開放擁有者讀寫。
- 只對你已審閱的專案授予信任。未信任時，專案層級套件不會載入；即使從個人層級或 `-e` 載入，擴充指令也不讀寫交接資料。`--approve` 僅授權該次 Pi 啟動。
- 卸載：`pi remove <安裝來源>`（專案層級加 `-l`）。已建立的交接檔、設定與 `AGENTS.md` 段落不會被自動移除。

## 開發與驗證

需要 Node.js 22.19.0 以上與 Git。不需全域安裝 Pi 或提供模型金鑰。

```sh
npm ci --ignore-scripts
npm run check         # TypeScript 型別檢查、行為測試、Pi CLI 冒煙測試
npm pack --dry-run    # 檢查要發行的檔案
```

測試使用獨立暫存專案；CLI 測試以離線模式載入實際套件，不呼叫模型。GitHub Actions 在 Ubuntu／Node 22 與 macOS／Node 24 執行相同檢查。

實作參考：[Pi 擴充 API](https://docs.pi.dev/latest/extensions)、[Pi 套件規範](https://docs.pi.dev/latest/packages)、[Git Porcelain 格式](https://git-scm.com/docs/git-status#_porcelain_format_version_1)、[Node.js 檔案 API](https://nodejs.org/api/fs.html)、[Node.js 測試執行器](https://nodejs.org/api/test.html)、[GitHub Actions Node.js 指南](https://docs.github.com/actions/automating-builds-and-tests/building-and-testing-nodejs)。

授權：MIT。
