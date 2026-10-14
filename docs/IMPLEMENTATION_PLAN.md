# Local-first Memory、資料防護與跨平台重構

## 0.6.3 歷史列表與五子 Agent（2026-10-14）

- 一般列表只顯示標題／時間；編輯模式提供多選／封存／刪除，完成與離開清空選取，刪除保留主機確認。
- 2–5 組獨立聊天室逐步驗證；成功組預設間隔 60 秒，首次失敗停止。429／登入／服務限制取消並降為單一請求，不自動重試。
- 真實 Mac／Chrome 五聊天室兩次均成功但串流峰值四個。五個唯讀子 Agent 實際完成合成文件分工與整合；13 個模型請求共用四名額與每 61 秒窗口八次本機節奏。
- 主 Agent 按需分派獨立探索／研究／審查工作；子任務不能寫檔、執行 Shell 或再次分派，父子共用輪數預算。
- 119 項單元、build、本機 Chrome localhost 與原生 VS Code 介面驗收通過；跨平台 CI／版本連結見 [VALIDATION](../VALIDATION.md)。Windows／Linux 真人 SSO 尚未驗收。

## 0.5.5 送出與停止控制項（2026-10-14）

- 修正使用者回報：送出區的「排入佇列」提示緊鄰停止方框，造成誤按停止。
- 停止移至任務進度旁，標示「停止」並說明會取消目前任務和待執行提問。「排入佇列」標示放在真正的送出按鈕內；空白不能送出。
- UI fixture 回歸滑鼠、鍵盤、草稿填入、排入佇列與獨立停止訊息。

## 0.5.4 獨立登入視窗與背景接續（2026-10-14）

- 使用者更新需求：移除難用的側欄縮圖，真人登入改用獨立瀏覽器；登入後可關閉視窗，VS Code 繼續連線。
- 登入視窗採正常桌面尺寸，成功後顯示「可以關閉此視窗」與「返回 VS Code」按鈕；8 秒後自動接續背景連線。
- 初次開啟只做背景還原，不自行彈窗。按「登入」才開啟視窗；輪詢確認登入就緒後，自動關閉並以相同瀏覽器／專用 Profile 啟動背景連線。手動關窗同樣回到背景，未登入時不誤報成功或循環彈窗。
- Chromium 使用原生 session 還原；不匯出 Cookie／Token，不複製 Profile。瀏覽器模式切換先完整釋放 Profile 鎖，保持 Session／Checkpoint／Project Memory。
- 驗收：localhost mock 的 HttpOnly session Cookie、視窗關閉後背景串流、取消與 UI；Windows／macOS／Linux CI。真實校方新 SSO 仍須人工驗收。

## 0.5.3 未登入狀態文案（2026-10-13）

- 側欄頂部未登入／已登出時顯示「登入」；只有登入狀態未知且瀏覽器連線中斷時顯示「重新連線 NTPU AI」。UI fixture 分別驗證兩種狀態。

## 0.5.2 清除過時瀏覽器控制項（2026-10-13）

- 0.5.1 發佈後的介面檢查發現連線設定仍留有已移除的小瀏覽器入口與無作用的背景模式勾選。
- 移除舊控制項並改正提示，避免使用者點到失效入口或誤以為還要開桌面瀏覽器。78 項 unit tests、本機真實 Chrome headless／Webview fixture 與 macOS arm64 VSIX 均通過；學校 SSO 未重驗。

## 0.5.1 VS Code 內真人登入與背景連線（2026-10-13）

- 使用者指定登入過程由 VS Code 內操作，不開啟桌面瀏覽器視窗；平時隱藏 Browser UI，由 NTPU AI 專用 Playwright Profile 在 Extension Host 背景連線。
- BrowserManager／BrowserBridge 強制 headless，即使舊設定明確為 false 也不會開桌面視窗。開啟 Agent 側欄會自動連線；網站需要真人登入／驗證時，僅顯示同一 BrowserContext 的即時登入畫面與鍵鼠轉送；Ready 後自動收起。沒有 iframe、Cookie 匯出或 CAPTCHA 自動化。
- `npm test` 78／78 通過；`npm run browser:fixture` 本機真實 Chrome headless 通過串流、task 內對話重用、附件、取消、持久 Profile 和 Webview 真人登入輸入測試；全程僅用 localhost mock，未連學校模型服務。
- NTPU SSO／CAPTCHA 在這次修改後尚未重新人工驗收；舊登入 Profile 的 headless 狀態探測及模型請求也未重跑。需要在使用者 VS Code 實際確認學校 IdP 接受此方式；不相容時如實顯示錯誤。

## 需求來源

完整記憶與防護規格見 [LOCAL_FIRST_REQUIREMENTS.md](LOCAL_FIRST_REQUIREMENTS.md)，追加瀏覽器與平台要求見 [BROWSER_PLATFORM_REQUIREMENTS.md](BROWSER_PLATFORM_REQUIREMENTS.md)。本文件追蹤實作與驗證，不能將尚未執行的 CI 或網站測試記為成功。

## 跨平台追加規格

- Browser Selection：Auto、Chrome、Edge、Chromium、自訂 Chromium 執行檔；Auto 優先受支援的系統預設瀏覽器，再依序嘗試已安装的 Chrome、Edge、Chromium。選擇須通過 Playwright 啟動，顯示結果與可用替代選項。
- 將偵測、啟動、平台與錯誤處理抽成 Browser Manager；保留 SSO、狀態、串流、附件與取消。不能僅開啟 URL 就宣稱自動化成功。
- 使用各平台本機應用資料目錄，依瀏覽器隔離 profile，拒絕一般使用者 Chrome／Edge profile；不匯出 Cookie／Token，不記錄驗證憑證，不使用遠端偵錯繞過保護。此次不實作 Attach Existing Browser。
- 切換瀏覽器／帳號須保留本機 Session、Task Checkpoint 與 Project Memory。資料不得放入專案或 Git。
- 目標平台 Windows x64、macOS arm64／x64、Linux x64（Ubuntu／Debian）；檢查路徑、CPU、執行檔、權限／鎖定、終端機、symlink／穿越、原生 sharp 依賴與 Extension Host。
- Remote SSH／Container／WSL 要明確報告 Extension Host 位置，不能假設可開本機桌面瀏覽器。
- 設定 UI：Browser、Custom Browser Path、Browser Profile Location、Connection Status、Reconnect／Change Browser；透過 VS Code Configuration API。
- CI：Windows／macOS／Linux、Node 相容性、unit tests、build、無學校帳號的 mock browser tests。按平台打包 VSIX；不再僅限 darwin-arm64。
- 實際驗證與 mock 結果分開報告；未實機驗證的平台明確標為尚未驗證。

## 分段提交

- [x] 1. 保存需求、盤點既有資料流與風險。
- [x] 2. 統一敏感路徑、內容遮蔽、傳輸與保存邊界；安全測試。
- [x] 3. 原子本機持久化、舊資料備份／遷移、Project／Session／Task、檢索與上下文管理；記憶測試。
- [x] 4. 整合 Agent、離線歷史、分頁、封存／刪除／匯出／備份還原、Project Memory 與 Privacy UI。
- [x] 5. Browser Manager、隔離 profile、跨平台設定與 shell／路徑防護；mock browser tests。
- [x] 6. 多平台 CI／VSIX、README／驗收文件、最終 build 與必要整合測試。

## 初始實作盤點

- SessionStore 只保存 25 個工作階段、每個 100 則訊息與少量 turns，存於 workspaceState；缺乏長期儲存、原子保存、分頁及 schema。
- browser.js 目前固定 Chrome channel；profile 為 home 目錄下固定路徑。每任務一個新網站對話，多輪沿用。
- 原本 isBlocked／safePath 僅涵蓋部分秘密與工作區边界；Editor、Terminal、MCP、使用者輸入、diff 和模型出口未使用共同遮蔽層。
- 工具透過一般 shell／stdio MCP 使用 OS 使用者權限，沒有完整 OS sandbox；不得宣稱完全阻止外部程式自主外洩。
- CI 與 VSIX 僅 macOS；sharp 需要依目標平台安裝與驗證。

每段完成時追加實際測試證據，再 commit。網站 smoke 須明確說明，不能在單元測試中消耗 NTPU AI 用量。

### 段落 2 證據

新增中央 guard，覆蓋檔案／Editor／使用者輸入／Terminal／MCP／模型出口／Session 保存。保護 Windows 與 Unix 憑證路徑，Review 檔案與附件單次確認；文字秘密遮蔽。含秘密的既有檔案禁止 Agent 改寫，避免把遮蔽值寫回憑證。MCP 自訂外部工具保留個別核准。圖片／PDF 無文字 OCR 防護，必須明示確認；Shell／stdio 仍沒有 OS sandbox。執行安全與工作區／工具測試 10 項通過，原有 38 項測試通過。

### 段落 3 證據

Schema 1、每 Session 原子 JSON snapshot、fsync／rename、跨視窗寫入鎖與 revision 衝突副本；全量歷史持久化、50 則分頁、舊 workspaceState 遮蔽備份與冪等遷移。Project／Session／Task 分層，來源 Task ID／路徑／時間，根據真實工具結果整理記憶，不另發模型請求。關鍵字與中文 bigram 檢索、字元 budget、恢復 checkpoint 要求重新讀取檔案。測試 18 項通過，包含原有 Agent 與 Session 相容測試；UI 整合繼續於下一段。

### 段落 4 證據

新增記憶與隱私頁：Project Memory 類型／來源／時間／stale、編輯刪除、離線歷史、Session 搜尋封存刪除、50 則分頁、完整匯出、備份與不覆蓋還原、未完成 Task 接續。app 真實初始化與 Account A／B mock 切換測試通過，checkpoint／歷史不依賴遠端帳號。build 通過；未使用真實 NTPU 帳號。

### 段落 5 證據

BrowserManager 獨立偵測／驗證／啟動；Auto、Chrome、Edge、Chromium、Custom，跨平台資料路徑、各瀏覽器獨立 profile、拒絕一般 profile／工作區／symlink 別名、遠端／WSL／無 GUI 明確錯誤。保留串流、取消、附件、每任務暫時對話。Browser 設定透過 Configuration API，更換前保存 Session。9 個瀏覽器／App mock 測試通過；macOS arm64 真實 Chrome headed／headless + localhost fixture 實際驗證串流、附件、取消、profile 重開保存，全程沒有 NTPU AI 請求。Windows／Linux 實機仍待 CI。

### 段落 6：本機驗證與 CI 驗收

本機 npm ci／build／59 項 tests／darwin-arm64 VSIX 成功。localhost 真實 Chrome 與新版 Webview 測試通過，沒有 NTPU AI 請求。2026-10-13，commit `931e5f7` 的 [CI 38393599933](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38393599933) 共 8 個工作全部成功：四平台 × Node 20／22，各自安裝依賴、unit tests、build、真實 headless 瀏覽器 localhost fixture、原生 sharp 驗證及 VSIX；Node 22 上傳四種 artifacts。前一輪 `38391905815` 的 macOS Intel Node 20 因套件下載 `ECONNRESET` 失敗，最新一輪成功。交付細節與未驗證範圍見 REFACTOR_REPORT.md。

### 最後的恢復驗證

補齊無工具輸出的初始 Task checkpoint（Task ID／完整恢復需求），同模式成功接續後標記舊中斷任務 resolvedBy、Project Pending stale；保留舊執行歷史。從真實完整 package.json 讀取整理依賴，來源帶 Task／路徑／時間；重複更新不重複新增，更新檔案後舊觀測 stale。新增回歸測試，總計 59 項。

### Cookie 防護補強

最終資料流核對補上 Cookie／Set-Cookie 標頭與結構化集合的主機遮蔽，阻止外傳並保持重複遮蔽的冪等性。60 項測試與 build 成功，版本 0.4.1 重新執行四平台 CI／打包。

### 最終 0.4.1 驗收

[CI 38395852343](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38395852343)，code commit `56c60e9`，四平台 × Node 20／22 全部 8／8 通過，各 60 項 tests、build、真實 headless BrowserBridge／Webview localhost fixture、sharp PNG 及原生 VSIX。macOS arm64 已安裝 0.4.1 並重新載入專用範例視窗，舊歷史、Browser 與 Memory／Privacy 頁確認正常；原使用者視窗草稿未改動。最終提交只更新驗收文件，不修改已驗證程式碼。

### 0.4.2 聊天紀錄列表管理

補充需求：直接在列表管理聊天。新增每筆重新命名／匯出／封存／刪除、勾選全選與批次操作、刪除確認與目前聊天替換、執行中限制；保留既有備份／Project Memory／原始碼。65 項本機 tests、build 與真實 Chrome localhost 列表 fixture 通過；沿用四平台 CI／VSIX。

0.4.2 最終驗收：[CI 38398505182](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38398505182) 全部 8／8 通過，各 65 項 tests 與四平台原生套件。原生 VS Code 已安裝 0.4.2 並確認列表管理；本段驗收提交僅更新文件。
