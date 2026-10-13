# 十一、跨瀏覽器與跨作業系統支援

在 Local-first Memory 與 Sensitive Data Protection 重構的基礎上，實作 Browser Compatibility 與 Cross-platform Support。

## 11.1 Browser Selection

將 `src/browser.js` 的 Chrome channel 固定啟動機制重構，支援 Auto、Google Chrome、Microsoft Edge、Chromium 及使用者指定執行檔的 Custom Chromium-based Browser。

Auto 優先選擇已確認受支援的系統預設瀏覽器；預設為 Firefox、Safari 或其他未支援瀏覽器時，偵測 Chrome、Edge、Chromium，並向使用者說明選擇結果。必須確認 Playwright 能成功控制瀏覽器，不能只以預設瀏覽器開啟 URL 就宣稱自動化完成。

瀏覽器偵測、啟動、錯誤處理須抽離 BrowserBridge，建立可測試的 Browser Launcher／Manager；保留登入、網站狀態、串流監聽、附件上傳與取消請求。

## 11.2 Browser Profile 與 Security

1. 預設獨立 Browser Profile，使用各作業系統適合的私人應用資料目錄。
2. 不使用 Chrome／Edge 的一般 Profile，各瀏覽器互相隔離。
3. 不記錄帳號驗證資料，不匯出 Cookie、Token 或驗證憑證。
4. 切換瀏覽器不得刪除 Local-first Session、Task Checkpoint 或 Project Memory。
5. 啟動失敗須說明原因與替代瀏覽器選項。
6. Attach Existing Browser 如實作，必須是獨立、明確警告的進階模式，不能預設啟用。
7. 不得用遠端偵錯繞過瀏覽器對預設 Profile 的保護。
8. Browser Profile 與 Agent Memory 不得意外提交到 Git。

## 11.3 Cross-platform Support

目標：Windows x64、macOS arm64／x64、Linux x64（優先 Ubuntu／Debian）。其他 ARM64 為後續擴充。

檢查並修正平台／CPU 判斷、路徑差異、執行檔偵測、Profile 路徑、權限與鎖定、Shell／Terminal 相容性、Symlink／穿越／敏感路徑、sharp 原生依賴與打包、Playwright 安裝／啟動、Extension Host 與 OS 整合。不得降低敏感資料防護。

Remote SSH、Dev Container、WSL 須區分 Extension Host 與使用者桌面位置，不假設遠端主機能啟動本機圖形瀏覽器。

## 11.4 Browser Settings UI

沿用既有風格，新增 Browser（Auto／Chrome／Edge／Chromium／Custom）、Custom Browser Path、Browser Profile Location、Browser Connection Status、Reconnect／Change Browser。透過 VS Code Configuration API，切換時保留尚未儲存的 Session、Checkpoint 與 Project Memory。

## 11.5 Build 與 CI

Windows／macOS／Linux CI、Node.js 相容性檢查、Unit Tests、Build Verification，以及不需真實 NTPU 帳號的 Mock Browser Tests。

VSIX 按原生依賴的平台產生；只有證明安全且相容才可 Universal。不得繼續將 darwin-arm64 硬編碼為唯一目標。

## 11.6 驗收

- Windows 偵測並啟動 Edge、macOS 使用 Chrome、Linux 使用受支援 Chromium 系瀏覽器。
- 手動選擇已安裝瀏覽器；Profile 保存登入狀態。
- BrowserBridge 串流與工具迴圈維持可用。
- 換瀏覽器不影響本機聊天記憶。
- 敏感檔案防護涵蓋 Windows／Unix 路徑。
- 多平台 unit／build／VSIX 通過。
- 未實際驗證的平台清楚標示尚未驗證。

交付實際程式碼、設定、測試、CI、README，不只提供方案；不繞過登入、驗證碼或用量限制。

### 0.5.0 驗收補充

四平台 Node 20／22 Unit、Build、Mock Browser 與原生 VSIX 已通過 CI。Node 22 的 macOS arm64／x64、Linux 增加真實 OS 沙箱／stdio MCP 與 Tesseract／Poppler 驗收。Windows OS 沙箱尚待人工實機測試，因此 Shell／stdio 拒絕執行是預期行為，不能要求關閉隔離後通過。Windows OCR 可用使用者設定指定 CLI 路徑，尚待實機驗收。

所有平台的新 SSO／CAPTCHA 都需人工操作；Mac 已驗證既有 Profile 還原與背景畫面，本輪真正模型完整任務遇 HTTP 502，未完成。側欄、背景模式、依賴與風險見 [瀏覽器及安全說明](BROWSER_SURFACE_AND_SECURITY.md)。

### 0.5.4 真人登入驗收流程

各平台在正常桌面 VS Code 安裝對應 VSIX；Linux 需有 DISPLAY／WAYLAND_DISPLAY。使用現有 Profile 的驗收不應先刪除或匯出登入資料。

1. 重新載入 VS Code，開啟 NTPU AI。既有登入有效時應直接背景連線，沒有桌面視窗。
2. 首次使用或由「設定 → 連線」登出後，按「登入」。確認 Chrome／Edge／Chromium 以正常視窗大小開啟，側欄沒有縮圖畫面。Windows 優先 Edge；Mac 優先 Chrome；Linux 使用 Chromium。
3. 人工完成學校登入、SSO 和 CAPTCHA。等待「登入成功，可以關閉此視窗」提示。
4. 分別驗收「返回 VS Code」、手動關閉登入視窗及等待 8 秒自動切換；確認設定顯示已登入，而且沒有保留桌面瀏覽器視窗。
5. 在 VS Code 送出一個簡短任務，確認模型真實回覆和工具迴圈。若學校服務回 HTTP 502／429，記錄未完成的驗收項，不自動反覆重試。
6. 登出後再開啟登入視窗，在未登入前關閉。確認介面沒有誤報成功、沒有反覆開視窗，再按「登入」可重試。
7. 重新載入 VS Code，確認相同 Profile 的登入仍可還原，且聊天記錄、未完成檢查點及 Project Memory 保留。

驗收只記錄平台、瀏覽器、版本、時間、成功／失敗及去識別化錯誤；不保存帳號、Cookie、Token、登入頁截圖或密碼。真實校方 0.5.4 SSO 驗收待使用者人工操作；mock browser 通過不能代替此驗收。
