# Linux 登入失敗：交給當地 Codex 的修復任務

將下方整段貼給 Linux 上的 Codex。請讓它在發生問題的 Linux 電腦、本機桌面與 VS Code 環境中處理。

---

請直接調查並修復這個 Linux 環境上的 `ntpu-ai-vscode` 登入失敗問題，完成程式碼、回歸測試、Linux VSIX 打包及可行的真人驗收。

## 專案與使用流程

- GitHub：<https://github.com/xujk0217/ntpu-ai-vscode>
- 這是非官方 NTPU AI VS Code 擴充套件，使用 `playwright-core` 控制獨立 Chromium 瀏覽器 Profile，模型來自 <https://ai.ntpu.edu.tw/>；不是透過官方模型 API 呼叫。
- 本機已有 Agent、聊天歷史、Project Memory、權限、Shell／MCP 沙箱與敏感資料防護。保留這些功能。
- 一般請求使用背景 headless 瀏覽器。未登入時按「登入」，應開出正常大小的瀏覽器，讓使用者人工完成學校 SSO／驗證；登入完成後轉回背景連線。登入視窗關閉後應仍能在 VS Code 使用 Agent。
- 各瀏覽器採獨立專用 Profile。切換登入視窗／背景模式須先關閉前一個 context，保留 Chromium 自己的登入儲存資料，不匯出 Cookie／Token。

## 實際問題與目前證據

Linux 使用者按登入時持續失敗，看到：

> 瀏覽器自動化啟動失敗。請關閉其他使用相同專用 profile 的視窗，或改選另一個已安裝瀏覽器。

這句話不能證明一定是 Profile 被占用。已確認原始碼把多種啟動／初始化錯誤都包成這一句，且只保留 `error.message` 的第一行，真正 Chromium stderr／失敗階段可能被截掉。尚未在這台 Linux 機器確認根因，不能直接宣稱是鎖定、缺套件、Snap 或 sandbox 問題。

先前 GitHub Actions 的 Linux x64、Node 20／22 與 Chromium localhost fixture 通過，圖形測試使用 `xvfb-run`。那是模擬網站，沒有使用學校帳號，不能當成這台 Linux 桌面或真人 SSO 已通過。

## 先閱讀的程式

- `src/browser/manager.js`
  - `executablePaths()`：Linux 搜尋 Chrome／Edge／Chromium，包含 `/usr/bin`、`/usr/local/bin`、`/snap/bin` 與 PATH。
  - `candidates()`：Auto 選擇系統預設的受支援瀏覽器，再嘗試其他候選。
  - `profile()`／`prepareProfile()`：獨立 Profile 路徑與權限。
  - `launch()`：檢查平台／遠端／DISPLAY，使用 `launchPersistentContext(..., { chromiumSandbox: true })`，再執行 page.evaluate、登入視窗調整。
  - `normalLoginWindow()`：透過 CDP 調整視窗尺寸。
  - catch 目前使用 `redact(error.message).split('\n')[0]`，最後再包成通用錯誤。
- `src/browser.js`：`_switch()`、`_open()`、`openLogin()`、登入後交接與 context 關閉、串流、附件、取消及任務對話清理。
- `src/app.js`：`getBridge()`、`login()`、`connectBrowser()`、`reconnectBrowser()`、Browser 設定與連線狀態。登入流程會先嘗試背景連線，不能假設一定已走到圖形登入階段。
- `src/security/guard.js`：錯誤遮蔽與敏感資料防護。
- `test/browser-manager.test.js`、`test/browser-auth.test.js`、`scripts/browser-fixture.js`、`.github/workflows/ci.yml`。

檔名與行為以實際 checkout 為準；先讀取現況與 AGENTS.md，不覆蓋既有未提交修改。

## 調查順序

1. 確認錯誤發生在本機 Linux 桌面 Extension Host，還是 Remote SSH／Dev Container／WSL／code-server。區分使用者桌面與 Extension Host；不要把遠端瀏覽器當成已連到本機桌面。
2. 收集必要環境：發行版、CPU 架構、Node／VS Code／擴充版本、執行使用者是否 root、VS Code 與瀏覽器的安裝來源、實際瀏覽器路徑與版本、X11／Wayland、Extension Host 可見的顯示環境變數。先確認錯誤與安裝版本確實對應目前程式。
3. 在保持相同沙箱與專用 Profile 設定下重現，區分候選探索、Profile 準備、Chromium spawn、頁面控制、CDP 尺寸調整、網站導覽、SSO 與登入後背景交接。先取得經遮蔽、限長且有意義的底層錯誤，再推論原因。
4. 依證據檢查：殘留的專用瀏覽器程序／實際 Profile 鎖、資料夾擁有者與存取權、瀏覽器 wrapper 是否來自 Snap／Flatpak、套件隔離是否限制該 Profile、Chromium 依賴、user namespace／sandbox、顯示服務連線及視窗尺寸 CDP 呼叫。
5. 原因不明時查 Playwright、Chromium、VS Code 或發行版官方文件，以最小且已遮蔽的錯誤關鍵字搜尋。整理各假設與證據，實際測試不同修復方法；一次失敗後繼續縮小原因，不只回覆「請自己換瀏覽器」。

## 修復要求與邊界

- 修改最小必要範圍，保留跨平台瀏覽器選擇、登入持久化、背景交接與 Agent 功能。
- 錯誤應區分實際原因，顯示候選瀏覽器、失敗階段、經遮蔽的原因與可操作下一步。只有實際鎖定證據才提示關閉占用 Profile 的視窗。
- 一般權限、依賴或隔離問題，不能一律改寫成 Profile 衝突。若只是非必要的視窗尺寸調整失敗，評估是否能安全保留已成功控制的瀏覽器並降級正常視窗，而非整個 context 關閉；用測試證明行為。
- 真正開啟 URL 不等於自動化成功；必須由 Playwright context／page 證明可以控制。
- 不添加 `--no-sandbox`、不關閉 Chromium sandbox，不要求用 root／sudo 啟動 VS Code。不以遠端偵錯繞過預設 Profile 保護。
- 不讀取或改用日常瀏覽器 Profile；不匯出、複製或記錄 Cookie、Token、SSO 憑證、密碼或登入頁內容。
- 不自動刪除 Profile 或 SingletonLock，不廣泛終止使用者的 Chrome。清理前須有專用 Profile 歸屬及程序已結束的證據，並保留登入資料。
- 不修改或刪除本機 Session、Task Checkpoint、Project Memory；不因錯誤消失就把連線狀態假設為成功。
- 不繞過學校登入、驗證碼、429 或用量限制。真人 SSO 操作交給使用者；等待人工操作時可繼續其他獨立工作。
- 不新增 GitHub 協作者或 AI 共同作者。

## 驗收與交付

1. 不需要學校帳號的測試：針對實際根因補有意義的回歸測試；不同失敗類型有正確訊息，診斷不洩漏憑證，失敗 context／程序可正常清理。既有測試與 build 通過。
2. 在這台真實 Linux 桌面，確認選定瀏覽器與專用 Profile 可由 Playwright 控制；真正顯示登入視窗。
3. 請使用者人工完成 SSO。登入後轉回背景模式，關閉登入視窗後仍可由 VS Code 發出一個簡短的真實 NTPU AI 請求；遇服務限制立即停止。
4. 重啟 VS Code，確認專用 Profile 的登入可恢復，或清楚區分校方登入真的過期與瀏覽器沒有連線。
5. 確認本機聊天與 Project Memory 保留。必要時用 localhost fixture 驗證串流、附件、取消與對話清理回歸。
6. 在 Linux 原生打包正確架構的 VSIX，不拿 macOS 套件重新標示成 Linux。
7. 完成後回報：根因證據、修改檔案、修復前後行為、測試結果、實際可安裝的套件位置、需要重新載入的步驟，以及尚未驗證的平台或 SSO 環節。無法完成時列出已嘗試的方法、精確阻礙與下一步。

請直接開始調查與修復，不要只給實作計畫。
