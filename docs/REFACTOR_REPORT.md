# 0.4.1 重構交付與驗收

## 架構

本機 MemoryStore 是歷史與任務的主要來源；BrowserBridge 是暫時的推論通道。Project／Session／Task 不包含網站帳號綁定。新的 Task 開新網站對話，同一 Task 工具輪次沿用，恢復與換帳號則重新以本機資料組裝脈絡。此版本未實作遠端聊天刪除或使用私有 API。

| 模組 | 用途 |
| --- | --- |
| src/security/guard.js | 路徑 Protected／Review／Normal、內容格式偵測、可重複遮蔽、外傳檢查、持久化 sanitize |
| src/workspace.js | Windows／Unix 路徑防護、工作區邊界、symlink 與穿越、原有讀取範圍／hash |
| src/memory/store.js | Schema 1 私有本機存放、原子寫入、revision、跨視窗鎖、衝突副本、遷移、分頁、備份／還原 |
| src/memory/context.js | Project／Session 摘要、實際工具證據、stale 更新、中文／英文關鍵字、相關 Task 與字元 budget |
| src/memory/actions.js | 記憶管理、Session 封存／刪除、Project 編輯／清空、接續 Task、備份／還原與設定 |
| src/sessions.js | 相容舊資料並保留中斷歷史，預設重置 full access |
| src/app.js | 初始化遷移、任務保存／checkpoint、脈絡整合、單次資料確認、Browser 設定、保留 UI 草稿 |
| src/agent.js / protocol.js | 受防護的模型出口、必要工具脈絡優先、可等待的 durable checkpoint |
| src/browser/manager.js | OS 預設瀏覽器、實際偵測、Playwright 控制確認、隔離 profile、平台與失敗處理 |
| src/browser.js | 網頁登入／狀態、SSE、上傳／取消；使用 BrowserManager 啟動與共用 Outbound Guard |
| src/tools.js / mcp.js | 結果／stdout／MCP 遮蔽、外部參數檢查、受保護檔案與編輯拒絕、個別 MCP 核准 |
| media/* | 50 則分頁、搜尋封存刪除、記憶與隱私頁、Browser 控制、帳號管理 |
| scripts/package.js / test.js | 真實 sharp PNG 自檢、host target 一致、跨平台測試清單 |
| scripts/browser-fixture.js / ui-fixture.js | localhost BrowserBridge + Webview 整合，不需要學校帳號 |
| .github/workflows/ci.yml | 四種平台、Node 20／22、unit／build／browser fixture／VSIX artifacts |

沒有新增 runtime 依賴。採 JSON snapshot 而非 SQLite，避開新原生資料庫依賴；很大的 Session 每次保存需重寫 snapshot，未宣稱適合無限大型資料。

## 狀態

已實作：三層持久記憶、完整保存／分頁、Schema 與冪等遷移、相關性檢索／budget、根據工具證據整理記憶、手動更新、跨帳號離線恢復、統一資料防護、Memory／Privacy UI、五種 Browser 選擇、profile 隔離、設定切換、多平台 CI／打包。

保留原 Agent 模式、權限、Skills、MCP、檔案／終端機／圖片工具、diff／回復、佇列與 Markdown 匯出。敏感檔案讀取／外傳與快照回復增加主機限制。

未支援：Attach Existing Browser、其他 ARM64／Alpine、遠端工作區檔案／終端機操作、語意向量檢索、圖片／PDF OCR 秘密辨識、完整 OS sandbox、Oh My OpenAgent runtime。介面可管理技術架構／決策；完整 package.json 讀取可整理已宣告的架構依賴，待辦依實際 Task 狀態保存。成功接續會標記舊待辦已解決，同時保留原中斷歷史；不從模型計畫猜測已完成架構。

## 遷移與可靠性

1. 於 `globalStorageUri/agent-memory/backups` 寫入遮蔽後的舊 workspaceState 備份。
2. 保留 Session ID、現存訊息、修改快照與 checkpoint，移至 `sessions/<id>.json`。原版本已截掉的紀錄無法恢復。
3. 重複匯入不重建相同紀錄；轉換失敗保留舊資料／備份並顯示錯誤。
4. 成功提交後移除舊 workspaceState 欄位；這是邏輯刪除，未宣稱抹除磁碟或 VS Code 的歷史備份。
5. 每次 snapshot 先寫新暫存檔、sync、rename，使用序列佇列及跨程序鎖。多視窗舊 revision 保留於 `conflicts` 並報錯；不覆蓋另一視窗更新。
6. 程式中斷留下的已提交 Session 檔可以重建索引。刪除 tombstone 防止其他視窗重新保存已刪 Session。
7. 備份還原使用新 Session ID，不覆蓋已有 Sessions。所有匯出、備份與長期記憶均先遮蔽。

## 防護與剩餘界線

Protected 路徑涵蓋 `.env`、私鑰、雲端／SSH／Kube 設定、受保護記憶／profile 目錄；可讀的 env 範本仍檢查內容。Review 路徑／附件先單次確認；full access 不繞過。所有 prompt 在 BrowserBridge 前再次檢查，包含模型直接視覺工具。

文字秘密與結構化 Cookie 集合／Cookie 標頭會遮蔽；外部查詢／工具參數若包含秘密會拒絕。原檔含秘密時禁止 Agent 改寫；redacted diff 不允許回復到檔案。資料權限沒有取消工作區邊界或 symlink 規則。

Shell／stdio MCP 使用 OS 權限，能自行讀取檔案或連網；本機 guard 只保護主機掌控的資料流，不能阻止所有惡意程式自行外傳。秘密偵測依已知格式與欄位，未知編碼／任意私人內容可能漏判。圖片／PDF／輸出圖片快取沒有 OCR 防護，必須由使用者檢查附件；不宣稱上傳或刪除能清除校方資料。

## 實際本機驗證

macOS arm64，Node 26.0.0：

- `npm ci --include=optional --offline`：成功（使用本機套件快取）。
- `npm run build`：成功。
- `npm test`：60 項通過，涵蓋歷史超過原本上限、重開、遷移備份／冪等、revision／衝突、專案隔離、跨帳號 mock、checkpoint、分頁／備份還原、路徑／秘密、真實 stdout 遮蔽、原 Agent、MCP、圖像。
- localhost fixture：真實 Chrome headed／headless 啟動、串流、每 Task 對話重用、附件、停止、profile 保存通過；新版 Webview 無 pageerror，檢查歷史分頁、登入狀態位置、Browser 設定草稿、Project Memory 顯示。
- `npm run package`：darwin-arm64 0.4.1 VSIX 打包成功，sharp 實際產生並解析 PNG。

此次重構驗證未使用真實 NTPU AI 帳號、未消耗學校模型用量。其他平台的真實瀏覽器結果見下列 CI 紀錄；mock 平台判斷與真實啟動分開驗證。

## CI 驗證紀錄

2026-10-13，commit `931e5f72fe148d1237312b19f7d321598b5d9e8d` 的 [CI 38393599933](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38393599933) **8／8 成功**。

| 平台／runner | 真實受控瀏覽器 | Node 20／22 | VSIX target |
| --- | --- | --- | --- |
| Windows x64／Windows Server 2022 | Edge（headless） | 兩者通過 | win32-x64 |
| macOS arm64／macOS 15 | Chrome（headless） | 兩者通過 | darwin-arm64 |
| macOS x64／macOS 15 Intel | Chrome（headless） | 兩者通過 | darwin-x64 |
| Linux x64／Ubuntu 22.04 | Playwright Chromium（headless） | 兩者通過 | linux-x64 |

每個工作包含 `npm ci --include=optional`、59 項 tests、build、BrowserBridge／Webview localhost fixture、sharp 真實 PNG 自檢及 VSIX 打包。Node 22 上傳四平台安裝套件。此前一輪 `38391905815` 的 macOS Intel Node 20 因 runner 下載依賴 `ECONNRESET` 失敗，最新一輪成功。

fixture 使用本機模擬網站與假的登入 cookie，實際驗證 Playwright 控制、串流、附件、取消、專用 profile 重開及 UI；不等同真實校方 SSO。Windows 一般桌面版本、macOS Intel 使用者装置、Linux 桌面互動 SSO、Debian 及 Remote Extension Host 實機尚未驗證。Remote SSH／Container／WSL 工作區執行與其他 ARM64 本版不支援。

## 使用與擴充

右上齒輪 → 記憶：檢視來源與 stale、編輯 Project Memory、控制自動更新、查看並接續未完成 Task、備份／還原。工作階段頁可搜尋封存刪除；聊天頂部可載入較早訊息。

右上齒輪 → 工具／設定：選 Browser／Custom Path／Profile Location、重新連線、管理帳號。更換前保存 Session。舊 Chrome profile 留在舊位置；新隔離路徑首次需重新登入，Cookie 不複製。

未來 Provider 只需實作 `chat(prompt, options)` 相容界面；MemoryStore／ContextManager／Guard 不依賴 NTPU 帳號。MemoryRetriever 可替換語意檢索，仍須經 Outbound Guard。對接其他 Agent Runtime 時，保留主機權限、資料防護和 checkpoint 提交邊界。

參考：[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)、[sharp 安裝與跨平台依賴](https://sharp.pixelplumbing.com/install/)、[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

## 0.4.1 防護補強

補上 Cookie／Set-Cookie 文字及結構化集合的遮蔽，含冪等與外傳拒絕回歸測試。本機 60 項測試與 build 成功；沿用同一四平台 CI 流程，修正版套件驗證連結見 GitHub Release。0.4.0 已在原生 VS Code 驗證舊歷史與記憶／Browser 設定頁啟動。
