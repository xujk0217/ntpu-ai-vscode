# 登入視窗、背景連線與本機執行隔離

## 瀏覽器介面

0.5.4 起，瀏覽器平時以 headless 模式在 VS Code Extension Host 背景執行，不顯示網頁。開啟側欄只還原既有登入，不自行彈窗。使用者按「登入」才開啟正常的獨立瀏覽器視窗，可使用完整的原生鍵盤、輸入法、貼上與捲動，完成學校 SSO／安全驗證。側欄只顯示簡短狀態提示，聊天紀錄仍可操作。

認證就緒後，登入視窗顯示「登入成功，可以關閉此視窗」及「返回 VS Code」按鈕。按按鈕、直接關窗或等待 8 秒，擴充功能會先完整關閉登入 BrowserContext，再以同一個瀏覽器執行檔與專用 Profile 啟動背景 BrowserContext。Chromium 的 `--restore-last-session` 原生還原登入 Cookie，不擷取、序列化、複製或匯出認證資料。此切換尚未確認背景認證前，介面顯示「正在接續」，背景網站真正就緒後才顯示「已登入」。關窗前尚未完成登入時不誤報成功，也不反覆彈出視窗。

「連線」設定可選擇瀏覽器並重新連線。登入視窗使用專用 Profile，沒有連接日常瀏覽器預設 Profile；以原生視窗尺寸約 1100 × 800 開啟，依螢幕可用範圍縮小。輸入直接留在瀏覽器，不會經過 Webview 訊息或 Agent 工具；已移除畫面串流及鍵鼠轉送。登入過程不寫入 Session／Project Memory，不提供模型登入工具。使用者自行完成 CAPTCHA／SSO。若學校工作階段過期或拒絕背景連線，顯示實際錯誤並要求重新登入。

沿用獨立 Profile 的設計，透過 [Playwright launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) 控制瀏覽器。沒有使用 VS Code iframe 或未公開的 BrowserView API。

## 設定分區

- **連線**：帳號、瀏覽器、重新連線。平時背景執行，按「登入」才開啟獨立視窗；執行檔與 Profile 路徑放在進階項目。
- **工具**：MCP、官方校務入口、圖像能力和模型深度說明。連線位址預設收起。
- **安全**：OS 沙箱狀態、附件檢查說明、指令核准規則。
- **記憶**：本機記憶、備份、還原與資料傳送政策。

## Shell / stdio MCP

使用 `@anthropic-ai/sandbox-runtime` 的 macOS Seatbelt／Linux bubblewrap。需要 Node 22.12 以上（由 VS Code Extension Host 提供），Linux 額外需要 bubblewrap、socat 與 ripgrep。Windows 後端尚未實機驗收，因此 Windows Shell／stdio MCP 暫時拒絕執行；受控檔案工具、網站模型與 HTTPS MCP 可使用。舊 Node 版本同樣拒絕執行，沒有普通 Shell 回退。

Shell 可讀寫選定工作區及私人暫存區；唯讀 Agent 與 stdio MCP 僅可寫暫存區。允許必要執行期與函式庫唯讀存取，禁止一般家目錄、工作區外使用者資料、憑證路徑與網路。每次執行前檢查現有工作區中的受保護路徑、未批准 Review 檔、符號連結、二進位和已知秘密。`node_modules` 是執行期依賴例外，不逐檔掃描；不得在依賴資料夾存放憑證。完整存取權限與自動核准都不能跳過 OS 隔離。環境變數不繼承主機憑證，stdio MCP 僅額外取得使用者明確設定的 SecretStorage 變數。

此隔離允許必要系統／套件執行期唯讀目錄，並非只暴露一個空白虛擬檔案系統；也不能取代作業系統／執行期的更新。HTTPS MCP 與公開網頁查詢由 Host 的受控網路工具執行，不受 Shell 的禁止網路設定影響。

### 依賴稽核

目前 sandbox-runtime 0.0.79 間接依賴 node-forge 1.4.0；npm audit 報告 RSA 簽章驗證弱點 GHSA-86w9-cpqp-85rv。此實作未使用憑證簽章驗證、CA 產生或 TLS 攔截功能，並拒絕啟動 MITM CA；仍保留依賴風險記錄，不宣稱稽核零弱點。不要以 `npm audit fix --force` 降級沙箱來消除報告；應追蹤上游修正版後更新與重測。

## 圖片／PDF 檢查

安裝本機 Tesseract（至少 eng 語言）及 Poppler：

- macOS：`brew install tesseract poppler ripgrep`。
- Ubuntu／Debian：`sudo apt-get install tesseract-ocr poppler-utils bubblewrap socat ripgrep`。
- Windows：安裝 Tesseract 和 Poppler，在使用者設定 `ntpuAI.attachments.ocr` 指定各 CLI 的絕對路徑；實機驗收尚待完成。

可設定 `language`、`tesseract`、`pdfinfo`、`pdftotext`、`pdftoppm`。設定為 application scope，避免工作區提供不可信的執行檔路徑。只使用標準 CLI 參數，圖片／PDF 不執行 Shell 字串。

圖片最多 20 格、40M 像素，PDF 最多 20 頁、需可解密讀取。PDF 的嵌入文字與全部渲染頁面均檢查；圖片逐格 OCR。20 MB 附件上限、單一原生工具 45 秒上限。已知秘密、缺頁、解析錯誤、缺少依賴均阻止上傳。原始 OCR 文字僅短暫存在記憶體，私人暫存檔在成功／失敗後刪除，不保存至 Log、記憶、備份或模型提示。

附件選擇、Agent 圖片／PDF 分析、BrowserBridge 上傳與 MCP 圖像快取共用檢查。通過證明綁定資料雜湊與原始 Buffer；單純設 `approved: true` 不能略過檢查。真人傳送核准仍然需要。OCR 可能漏字、漏辨私人資訊、QR 或非標準秘密，通過只代表未識別到已知格式，不能保證附件沒有任何敏感資訊。未實作 OCR 全文檢索、生成照片或所有 NTPU PDF 模型路由保證。

## 驗收

- `npm test`：確定性單元與整合測試；指令及 stdio 測試明確注入測試執行器，不能冒充 OS 沙箱驗收。
- `npm run browser:fixture`：localhost 真實 Chromium，驗證正常背景連線、登入成功提示／返回按鈕／倒數、HttpOnly session Cookie 還原、手動關窗、取消、串流、上傳及 Profile 保存。Linux CI 透過 Xvfb 執行可見登入視窗測試。
- `npm run sandbox:fixture`：真實 OS 隔離，工作區外讀取／憑證／網路阻擋及工作區寫入。
- `npm run ocr:fixture`：真實本機 Tesseract／Poppler，乾淨圖片／PDF 通過、合成秘密拒絕。
- 真實 NTPU SSO：依 `docs/BROWSER_PLATFORM_REQUIREMENTS.md` 人工登入流程驗收；不得自動完成 CAPTCHA 或提取憑證。0.5.4 登入／背景切換只用 localhost mock 回歸，學校 SSO／CAPTCHA 尚未重新人工驗收。

2026-10-15 Linux 桌面已驗證既有登入恢復、真人確認視窗與背景真實請求，詳見 [Linux 驗收紀錄](LINUX_LOGIN_VALIDATION.md)。全新學校 SSO、Windows 與 Intel Mac SSO 尚未重新實測。CI 是 Mock 網站及原生工具測試，不代表學校 SSO 驗收。
