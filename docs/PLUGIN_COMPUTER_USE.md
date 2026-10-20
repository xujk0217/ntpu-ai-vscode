# 本機 Plugin／MCP 與 Computer use（0.6.20）

這兩個功能用途不同：外部 Plugin 讓其他 Agent 請 NTPU AI 提供分析；Computer use 則由 VS Code 裡的 NTPU Agent 操作已核准的工作畫面。模型仍透過校方網站的專用 Chromium Profile，沒有改用官方模型 API，也不需要 OpenAI API 金鑰。

## 讓其他 Agent 使用 NTPU AI

先在本機 VS Code 安裝本版、重新載入並人工登入 NTPU AI。命令面板依序執行：

1. **NTPU AI: 啟用外部 Agent 橋接**。
2. **NTPU AI: 匯出本機 Plugin／MCP 設定**，選擇一個資料夾。
3. 匯出的 `ntpu-ai-plugin/` 包含 `plugin.json`、`mcp.json`、`server.bundle.cjs` 及 `skills/ntpu-ai/SKILL.md`。支援此 Plugin 格式的本機 Agent 可匯入此資料夾；其他 MCP 主機可使用 `mcp-client.json` 中的 stdio 設定。主機需有 Node.js 20.9 以上。

不會自動更改其他 Agent 的設定。Plugin 格式參考 [OpenAI 的 Plugin 文件](https://developers.openai.com/plugins/build/plugins)；本專案沒有上架 OpenAI Plugin 公開目錄，也不表示每個 Agent 都支援相同的 Plugin 匯入方式。MCP 是較通用的接法。

GitHub Release 另提供 `ntpu-ai-0.6.21.plugin.zip`，這是跨平台的 Node.js stdio 工具包，沒有登入資料或機器路徑；不是 VSIX，也不能獨立登入校方。優先使用 VS Code 匯出功能取得已連到本機橋接的設定；若手動使用 ZIP，將 `NTPU_BRIDGE_FILE` 指向**該次匯出設定**所指定的連線檔，或加入 `--connection <該連線檔路徑>`，不要讀取、複製或貼出連線檔內容。

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `ntpu_status` | 查本機橋接狀態；ready 是最近已知狀態，送出前仍會重新檢查連線 |
| `ntpu_start_task` | 提交 1–20,000 字的明確非敏感文字，取得工作 ID |
| `ntpu_task_status` | 查該工作的排隊／執行／完成／未完成／取消／失敗狀態 |
| `ntpu_read_result` | 依 offset 讀取已保存原文，每頁最多 10,000 個 JavaScript UTF-16 碼元；接續 nextOffset |
| `ntpu_cancel_task` | 取消指定外部工作，保留已保存的結果 |

外部請求在 VS Code **逐次確認傳送文字**，沒有繼承本機聊天、Project Memory、附件或工作區工具。回覆是供外部 Agent 整合查證的分析，不會把外部 Agent 的工具權限交給 NTPU 模型。主任務、核准、登入、附件準備或排隊尚未處理時，外部請求會失敗並說明原因；不搶占主任務。最多五個未結束的外部請求依序處理。

結果分段寫入該橋接的私有儲存區，單一結果上限 8 MiB；超過或保存失敗會標示失敗，不假裝完整。必須同時確認 status 與 complete；有一頁結果不代表整份完成。取消、關閉橋接後保留已保存原文；本版不提供跨重啟工作回復 API。原本的聊天與記憶不變更。

橋接只監聽 127.0.0.1 的臨時埠，透過私有連線檔驗證，拒絕瀏覽器 Origin 請求。此本機能力值不是校方 Cookie／Token，不包含學校帳密，也不寫入 Plugin；POSIX 檔案為 0600、資料夾為 0700，Windows 使用使用者儲存區繼承的 ACL。每個啟用中的 VS Code 視窗有不同連線，請明確使用該視窗的匯出設定。

執行 **NTPU AI: 停用外部 Agent 橋接**、關閉或重新載入 VS Code 都會停止並取消該橋接。重新啟用後須重新匯出設定（可另選資料夾）；舊設定會顯示無法連線。不能把本機連線檔與設定交給遠端 Agent 當成可直接連本機的服務。遇 SSO、驗證、429 或服務限制立即停止，由使用者處理，不自動重試。

## Computer use

在 **build** 模式要求 Agent：「用獨立工作瀏覽器開啟 http://localhost:3000，觀察後測試按鈕，最後重新觀察驗證。」工具會依現有目錄被模型選用。

| 工具 | 行為 |
| --- | --- |
| `computer_open` | 核准後開啟 browser 工作目標，或由使用者選定 desktop 視窗 |
| `computer_observe` | 核准後擷取選定畫面，回傳一次性 observation；瀏覽器另提供可見文字及控制項 ID |
| `computer_action` | 需要最新 observation，每個動作獨立核准；執行後必須重新觀察 |
| `computer_close` | 關閉本任務專屬瀏覽器，或解除視窗控制，不關閉使用者原生程式 |

即使是完整存取模式，每次觀察／操作仍會要求確認。plan／review／research／ask 與唯讀子 Agent 不提供這些控制權。原生桌面需帶 question 並取得核准的實際畫面分析，單純保存截圖不算結果已驗證；未驗證就關閉目標後，另開目標觀察也不能抵銷。沒有觀察到操作結果，主機會阻擋成功結語；無法驗證時應明確回報未完成。取消會關閉本任務的工作瀏覽器，原生輸入後端釋放自己按下的鍵與滑鼠按鈕。

### 獨立工作瀏覽器

支援 Windows x64、macOS arm64／x64、Linux x64 的 Chromium 瀏覽器。使用 `computer-use/computer-profiles/` 專用 Profile，與模型登入 Profile 及日常 Profile 分離；保留 Chromium sandbox，不讀取日常瀏覽器或匯出登入資料。瀏覽器開啟後由 Playwright 實際控制頁面，開 URL 本身不當成成功。

此版限定核准的**單一 origin（協定、主機、埠）**：DNS 固定到通過檢查的位址，跨來源資源、WebSocket、嵌入頁面、彈出視窗、檔案上傳及下載受阻。公開 HTTP(S) 目標需通過既有公開網路檢查；可明確核准 localhost 開發預覽，不允許其他私有位址／雲端 metadata 位址。網路開關關閉時只允許 localhost 預覽。多來源正式網站不一定適用此受限瀏覽器。

支援控制項 ID 的 click／fill、基本單鍵、有限捲動及同來源 navigate；不提供任意頁面 JS 工具。fill 支援 Unicode。學校模型網站不允許作為工作目標；可辨識的登入、密碼、OTP、驗證碼與嵌入畫面會拒絕擷取。這些檢查不能識別所有敏感畫面，核准前仍應確認選定內容。

### 原生桌面範圍

Linux 原生桌面支援 **X11／XWayland 視窗**，需 `/usr/bin/python3`、PyGObject、GDK 3、libX11 與 libXtst。使用者從視窗清單明確選定單一視窗，最大 3072×2048；不做整個桌面擷取、不讀剪貼簿、不記錄鍵盤。日常瀏覽器、終端機、常見可嵌入終端機的 IDE 及可辨識的登入視窗不提供控制；網頁使用獨立工作瀏覽器。

視窗類別排除只是一層防誤用措施，不是通用 OS 沙箱；無法識別任意更名程式，逐次核准不授予繞過既有檔案／Shell 權限的能力。

動作限視窗內 click、少量捲動、基本單鍵及目前鍵盤映射可輸入的文字；不接受系統組合快捷鍵。操作前確認視窗幾何、焦點與滑鼠目標。原生 type 是鍵盤事件，會受目前輸入法影響；必須重新觀察文字結果，不能保證原始字串輸入成功。Unicode 表單輸入優先使用瀏覽器 fill。

**原生 Wayland 視窗、Windows 原生桌面及 Remote SSH／Container／WSL 不支援此桌面後端。** Wayland 桌面下只可能看到 XWayland 視窗，沒有列出的視窗不能宣稱已控制。Windows／macOS 仍可用上述獨立工作瀏覽器。

### 截圖與模型分析

截圖先走既有附件檔案型態與本機 OCR 敏感資料掃描，依附件 OCR 設定需要 Tesseract 等依賴；失敗會說明，不繞過掃描。圖片作為本機聊天 artifact 保存，最多 8 MiB。`computer_observe` 的 question 可要求視覺分析；送到校方模型前另一次確認，只送選定截圖與分析問題，並共用主任務的模型輪數、節奏與服務限制。未核准時圖片仍只在本機；可見文字與控制項則是該次觀察授權的模型輸入。

## 可重現驗證

- `npm test`：MCP 真正 stdio 接線、分頁長文、權限／取消／429、控制權與觀察狀態回歸。
- `npm run computer:fixture`：真實 Chromium 控制 localhost 合成頁面、Unicode fill、click、讀回驗證、登入欄位與 iframe 擷取攔截；不使用學校帳號。
- `npm run desktop:fixture`：在 Linux 桌面建立自己的合成 GTK X11 視窗，測試選定視窗截圖、點擊、輸入及重新觀察，以程式收據確認結果；不碰使用者私人視窗。合成文字欄位關閉 IME，以驗證鍵盤後端。
- `npm run browser:fixture`：既有登入視窗／背景交接、串流、附件、取消、清理與介面回歸。
- `npm run plugin:package`：產生不含機器連線資料的可攜 Plugin ZIP；VSIX 仍各平台原生打包。

上述不代表真人 SSO、校方視覺模型或外部 Agent 端到端驗收已完成；需在安裝後由使用者確認授權與實際校方請求。

Linux 缺少依賴時，可由使用者／系統管理員安裝 `tesseract-ocr poppler-utils python3-gi gir1.2-gtk-3.0 libxtst6 bubblewrap socat ripgrep`；這是安裝依賴，不是用 root 啟動 VS Code。若工具放在自訂路徑，附件設定中的 `ntpuAI.attachments.ocr` 可指定 Tesseract／Poppler 執行檔；不要填暫存目錄作為長期安裝位置。

## macOS 原生單一視窗（0.6.25）

需要 macOS 14+，使用者在「系統設定 → 隱私權與安全性」授予 VS Code **螢幕與系統音訊錄製**、**輔助使用**權限後重新啟動。工具只檢查權限，不自動修改權限或擷取整個桌面。Intel／Apple Silicon 的 VSIX 於相符主機編譯並隨附 helper；使用者不需 Swift、Python 或額外的桌面套件。

選定視窗的擷取使用 `ScreenCaptureKit` 的單視窗 filter。每次重新核對視窗 ID、PID、Bundle、標題與幾何；操作時另核對焦點與座標命中的 AX 視窗。AX 安全輸入欄位、可辨識的登入內容、日常瀏覽器、終端機及常見 IDE 會拒絕。視窗結構無法安全檢查時也停止；這不是通用 OS 沙箱，不保證辨識任意更名程式或自繪敏感畫面，使用者仍需逐次核准。

- `click`：以視窗內座標找到控制項，執行 AXPress，或聚焦 AXTextField／AXTextArea；無 AX 支援的控制項拒絕，不回退全域滑鼠。
- `type`：1–1000 個可列印字元，透過定向至選定 PID 的 Unicode 鍵盤事件；每字重新確認焦點，保留輸入法／應用程式差異，必須觀察結果。
- `key`：僅基本單鍵，不允許系統組合快捷鍵。取消在 down/up 成對送出後結束，不保留按住狀態。
- `scroll`：指定視窗內 x/y、`direction: up|down`、`count: 1–10`；只調整該 AX 垂直捲軸的有限比例，無可核對捲軸或已到邊界會說明。

螢幕錄製、Accessibility、視窗關閉／身分改變、位置改變、焦點切換、拒絕操作及 helper 缺失均回報明確錯誤。不讀剪貼簿、不做全螢幕擷取、不使用 AppleScript 或任意 Shell。

開發驗收：`npm run desktop:macos:fixture`，需 Xcode Command Line Tools 與桌面權限，只建立自己的 AppKit 測試視窗，以實際程式收據驗證；CI 只編譯與執行 mock 回歸，不冒充已有 TCC 授權的真人桌面驗收。
