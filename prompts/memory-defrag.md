---
description: 記憶整理（defrag）：合併重複、刪除過期，把 AGENTS.md 與交接檔重排回可讀的規模
argument-hint: "[focus: agents|handoff|all]"
---
對本專案的 agent 記憶做一次整理（memory defrag）。重點：這是**重排與精簡**，不是清空。

整理範圍：${@:-all}（`agents` 只理 `AGENTS.md` 系列，`handoff` 只理交接檔，`all` 兩者都理）

步驟：

1. 盤點：列出根目錄 `AGENTS.md`、各子目錄 `AGENTS.md`、交接檔，統計行數與重複率；先讀完再動手。
   交接路徑預設為 `docs/HANDOFF.md`，依 `.pi/handoff.json` → `./handoff.json` → `PI_HANDOFF_PATH` 覆蓋。若無法確認，請使用者提供 `/handoff-status` 顯示的路徑。
2. 逐條判定，產出三類清單：
   - **保留**：仍然成立、且無法被自動化檢查取代的規則與踩坑。
   - **刪除**：已過期（指令不存在、檔案已改名、行為已改）、或已被 lint／驗證腳本
     ／Pi extension 取代的文字規則。
   - **搬移**：只屬於某個模組的知識 → 搬到該模組目錄的 `AGENTS.md`；跨模組慣例留在根目錄。
3. 合併重複：同一件事在多處出現時，只留一份權威版本，其他地方改成一句話指標。
4. 交接檔只留「當前狀態」：五個 session 前的「我在做什麼」屬於雜訊，
   已被 commit 紀錄取代的內容直接刪除（必要歷史在 `.pi/handoff-history/`）。
5. 目標規模：根目錄 `AGENTS.md` 每節 ≤ 30 行、單條坑 ≤ 4 行；交接檔 ≤ 80 行。

規則：

- 不得刪除仍然有效的決策與死路紀錄；有疑慮就標「待確認」，不要自行抹除。
- **先列清單給我看（刪除項要附證據：為什麼過期），等我同意後再寫入。**
- 寫入後依本專案的 commit 規範提交；文件與設定分開成不同 commit。
