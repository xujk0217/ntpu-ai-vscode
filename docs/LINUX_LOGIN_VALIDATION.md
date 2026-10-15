# Linux 登入診斷與驗收（0.6.11）

日期：2026-10-15，Asia/Taipei。實機驗收不等同所有 Linux 發行版或全新學校 SSO 已通過。

## 結論與根因界線

已確認並修正的程式問題是：原版將 Profile 政策、權限、Chromium spawn、頁面控制及 CDP 視窗調整等不同失敗統一包成 Profile 衝突，且只保留 `error.message` 第一行，遺失真正 stderr。初始化／導覽失敗還可能留下 context；連線嘗試失敗時可能保留先前 ready 狀態。

最初回報的那一次失敗沒有完整 stderr，無法回溯確認其底層根因。原版 browser manager 在本機一般程序及 VS Code Extension Host 都成功控制同一專用 Profile 的背景／圖形 Chrome，因此不能宣稱此機器必然缺依賴、sandbox 被阻擋或 Snap 不相容。

調查期間另確實重現 Singleton 衝突：Chromium stderr 出現 `SingletonLock: File exists (17)`、exit code 21，專用 Chrome 的父程序指向本次第一個診斷開發視窗的 Extension Host。該視窗後來啟動原版 Agent 並持有 Profile；正常關閉該診斷視窗後，完整流程成功。這是調查期間的競爭，不是最初回報的根因證明。沒有刪除 SingletonLock、Profile 或廣泛終止 Chrome。

## 實機環境

| 項目 | 實測 |
| --- | --- |
| 系統／架構 | Ubuntu 24.04.4 LTS，Linux x64，非 root（UID 1000） |
| 桌面 | Wayland，Xwayland；實際 Extension Host 可見 DISPLAY=:0、WAYLAND_DISPLAY=wayland-0、XDG_RUNTIME_DIR=/run/user/1000 |
| VS Code | 1.141.0，classic Snap；Extension Host Node 24.21.0 |
| Extension Host | 本機 UI host，remoteName 為空；非 SSH／Container／WSL／code-server |
| 原安裝／checkout | 原安裝 0.6.9；checkout 0.6.10 @ 15a6bbc，原先工作樹乾淨；兩者 browser manager／bridge 相同 |
| 修補版本 | 0.6.11，已透過 VS Code CLI 安裝 Linux x64 VSIX |
| 瀏覽器 | Google Chrome 155.0.8059.79，Debian 套件；/usr/bin/google-chrome → /opt/google/chrome/google-chrome |
| Playwright | playwright-core 1.64.0 |
| 專用 Profile | VS Code globalStorage/ntpu-local.ntpu-ai-coder/browser-profiles/chrome，UID 1000，權限 0700 |
| Sandbox | chromiumSandbox:true；未新增 --no-sandbox、未停用安全機制 |

工具命令本身在隔離環境時無法執行 Snap CLI，npm 曾因 DNS 限制失敗；改在一般使用者的本機執行環境驗證後成功。這兩個工具環境限制不能當成 Extension Host 的登入根因。

## 修改及失敗處理

- `src/browser/diagnostics.js`：安全保留有限多行原因，移除完整 launch args、所有 HTTP(S) URL、Cookie／Authorization 等已知秘密，移除 ANSI／控制字元；限制 12 行、每行 650 字、原因總長 3500 字。
- `src/browser/manager.js`：顯示候選瀏覽器、執行檔、背景／登入視窗、失敗階段、原因類型與下一步。權限／依賴／sandbox／顯示服務錯誤不再被當成 Profile 占用。ProcessSingleton 建立失敗只要求檢查鎖與程序，沒有宣稱一定存在存活占用者。
- CDP 視窗尺寸調整可降級：僅在再次成功執行 page.evaluate 後保留已控制視窗，並顯示警告。若頁面也失去控制，關閉 context 並報錯。
- `src/browser.js`：初始化／導覽失敗關閉已建立 context，清除控制資訊；背景交接失敗標明交接操作，底層啟動階段仍保留。
- `src/app.js`：失敗連線設為 ready:false、authentication:unknown，不宣稱學校已登出或憑證過期。
- 保留跨平台選擇、每瀏覽器獨立 Profile、先關閉前 context 才交接、Chromium 原生登入儲存、Agent、權限、Shell／MCP 與敏感資料防護。

## 驗收結果

1. `npm test`：185 項通過。新增多行 stderr、權限／依賴／sandbox／顯示／Singleton／未知類型、憑證遮蔽與限長、候選與階段、CDP 失敗降級／控制喪失清理、初始化／導覽清理、失敗連線狀態及背景交接回歸。
2. `npm run build`：通過。
3. `npm run browser:fixture`：在這台 Linux 真實桌面，使用系統 Chrome 與 Chromium sandbox 通過；沒有使用 Xvfb。驗證 localhost 串流、附件、取消、並行、僅刪除自己建立的對話、登入提示／返回／倒數、手動關窗、未完成登入不誤報、HttpOnly session Cookie 原生恢復與 Profile 持久化。這是模擬網站，不是學校 SSO。
4. 真實 NTPU AI：在 VS Code Extension Host 透過實際 BrowserBridge 與既有專用 Profile 恢復有效登入；顯示可由 Playwright 控制的圖形視窗，觀測 outerWidth/outerHeight 約 1132×842（含視窗邊框）。使用者回覆「視窗正常，已按返回或關閉」，稍後另回報在日常視窗直接登入成功。16:29:55 確認背景 authenticated；16:29:58 透過網站 UI 完成一句簡短請求，觀測到完整串流與 7 字回覆，不保存回覆或帳號內容。只清理該驗收建立的 1 筆網站對話，成功。
5. 關閉後重新建立背景 context，仍 authenticated。另使用已安裝 0.6.11，在獨立 VS Code 程序結束後重新啟動同一測試實例，兩次均可恢復有效背景登入，Extension Host／VS Code 程序 ID 不同。未關閉使用者原本承載工作的主視窗；日常視窗仍需 Reload Window 載入新版本。
6. 本機記憶：基準共 7 檔。index 與原有聊天檔案雜湊一致；1 筆驗收開發視窗的空白 Session 正常保存後 revision 由 1 變 2。僅還原該 revision 數值於記憶體中計算雜湊，即與基準完全相符，證明其餘內容未改變；沒有寫回或覆蓋 Session。未建立／修改 Project Memory；現有全套記憶與 checkpoint 回歸通過。此機器當時沒有 projects 記憶檔，既有 Project Memory 實體內容持久化由 fixture／整合測試驗證。
7. `npm run package -- --target linux-x64`：在本機 Linux x64 執行，sharp 真實 PNG 編解碼檢查通過。VSIX 安裝成功；套件 manifest 目標 linux-x64，內含 Linux x64 sharp ELF。

## 安裝與接續

套件：專案根目錄 `ntpu-ai-coder-linux-x64-0.6.11.vsix`。可用 Extensions → Install from VSIX 安裝，或 `code --install-extension /absolute/path/ntpu-ai-coder-linux-x64-0.6.11.vsix --force`。

日常 VS Code 視窗執行 Developer: Reload Window，再開 NTPU AI 檢查連線。不要登出／刪除 Profile 來重新載入。若再失敗，保留新版顯示的候選、階段與遮蔽後原因；先確認是否有另一個 VS Code 視窗持有同一專用 Profile。不要把未連線狀態直接當成學校登入失效。

尚未驗證：新一次輸入學校帳密／CAPTCHA／SSO redirect（現有登入仍有效，沒有強制登出）；使用者原始主視窗整個應用程式重啟及原始歷史 UI 人工比對；Chrome 以外的 Linux 瀏覽器／Snap Chromium／Flatpak／其他發行版；macOS 與 Windows 本次修補的真人桌面與 SSO。沒有繞過學校登入、驗證或服務限制。

## 參考依據

- [Playwright：啟動錯誤診斷](https://playwright.dev/docs/ci#debugging-browser-launches)：Chromium 啟動 log 可用於判斷真正的底層錯誤。本次由錯誤中的 stderr 取證，沒有開啟原始憑證日誌。
- [Playwright：BrowserType](https://playwright.dev/docs/api/class-browsertype)：persistent context 與 Chromium sandbox 選項。
- [Chromium ProcessSingleton 原始碼](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/process_singleton_posix.cc)：鎖、socket 與程序通知機制；單一泛化錯誤不能證明是哪個程序或權限原因。
