# 側欄瀏覽器與本機執行隔離

## 瀏覽器介面

側欄右下角的「瀏覽器」按鈕開啟可互動的 NTPU AI 網頁畫面。點選畫面後可輸入文字、貼上、按 Enter／Tab、捲動。它操作同一個 Playwright Chromium 與專用 Profile，登入和模型串流共用連線；收起面板不會登出或停止引擎。Agent 執行中暫停手動網頁操作，避免干擾工具迴圈。

「連線」設定可選擇背景瀏覽器並套用。此時 Chromium 引擎仍在執行，但不顯示獨立視窗。一般登入和 HTTPS SSO 頁面可在面板操作；若驗證碼、SSO 或瀏覽器安全政策要求原生視窗，使用「原生視窗」。此操作保留同一 Profile，可能需要重新載入網站；執行中的任務禁止切換模式。背景模式與 SSO 的相容性依學校服務而異，不能保證全部驗證流程適用。

畫面是記憶體中的 JPEG 串流，輸入是使用者直接發起的鍵鼠事件，沒有提供給模型的螢幕讀取或登入工具。畫面、輸入與密碼不寫入 Session、Project Memory 或檔案。關閉側欄／面板即停止畫面更新。瀏覽器本身依正常網站行為保留登入資料。無 Cookie、Token 匯出或遠端預設 Profile 連線。

參考 [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) 的獨立 Profile／瀏覽器宿主概念。該專案實際使用 Electron Launcher 的 WebContentsView，並非 VS Code iframe。此擴充自行實作受控畫面介面，未複製該專案的 Electron Launcher 程式碼；不宣稱使用 VS Code 未公開的原生 BrowserView API。

## 設定分區

- **連線**：帳號、瀏覽器、背景模式、重新連線。執行檔與 Profile 路徑放在進階項目。
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
- `npm run browser:fixture`：localhost 真實 Chromium，包含設定、小瀏覽器鍵鼠、串流、上傳、取消、Profile 保留。
- `npm run sandbox:fixture`：真實 OS 隔離，工作區外讀取／憑證／網路阻擋及工作區寫入。
- `npm run ocr:fixture`：真實本機 Tesseract／Poppler，乾淨圖片／PDF 通過、合成秘密拒絕。
- 真實 NTPU SSO：依 `docs/BROWSER_PLATFORM_REQUIREMENTS.md` 人工登入流程驗收；不得自動完成 CAPTCHA 或提取憑證。Mac 可用既有登入測試重啟，但這不代表全新 SSO／CAPTCHA 已驗收。

Windows、Linux 桌面與 Intel Mac SSO 尚未實測。CI 是 Mock 網站及原生工具測試，不代表學校 SSO 驗收。
