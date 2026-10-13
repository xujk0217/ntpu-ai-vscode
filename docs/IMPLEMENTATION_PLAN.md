# Local-first Memory、資料防護與跨平台重構

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
- [ ] 6. 多平台 CI／VSIX、README／驗收文件、最終 build 與必要整合測試。

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

### 段落 6：本機驗證與 CI 待驗收

本機 npm ci／build／57 項 tests／darwin-arm64 VSIX 成功。localhost 真實 Chrome 與新版 Webview 測試通過，沒有 NTPU AI 請求。新增 8 工作 CI 與四種平台 artifacts；將在 GitHub 實際執行後追加結果。交付細節與限制見 REFACTOR_REPORT.md。
