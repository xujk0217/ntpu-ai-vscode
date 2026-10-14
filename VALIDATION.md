# 本地使用驗證

## 0.6.2 歷史列表與逐步並行（2026-10-14）

- 112 個單元測試通過；原有歷史管理刪除確認／取消、Project Memory 保留等測試保留。新測試涵蓋逐組 2–5、串台、串流不重疊、401／403／429／503 停止、取消、3–5 排程上限及證據過期／Profile 不符／使用者上限降級。
- Chrome localhost mock／UI fixture：一般模式沒有 Checkbox／管理選單，點項目直接切換；編輯模式多選封存／刪除、完成／關閉／分頁切換清空選取、執行中鎖定。5 個實際 mock 網站串流重疊且互不串台；設定選單與各組報告可操作。
- macOS arm64／Chrome／真實 NTPU AI，2026-10-14 13:04（Asia/Taipei），首次快速逐組測試結果如下；未保存模型原始回答或驗證憑證：

| 同時請求 | 有效成功率 | 全組串流重疊 | 串台 | 平均回應耗時 |
| --- | --- | --- | --- | --- |
| 2 | 2/2，100% | 是，峰值 2 | 未偵測到 | 4469 ms |
| 3 | 3/3，100% | 是，峰值 3 | 未偵測到 | 3979 ms |
| 4 | 4/4，100% | 是，峰值 4 | 未偵測到 | 4368 ms |
| 5 | 0/5 | 未確認，峰值 0 | 未偵測到有效回覆 | 377 ms（拒絕／取消耗時） |

- 5 個這組有四個 HTTP 429「每分鐘最多 10 題」，一個因同組失敗取消；立即停止，無重試，推薦／實際上限降為 1。較低組的成功紀錄保留，但不能把分鐘限制當成「最多並行 4」或宣稱 5 不受支援。
- 新增成功組之間預設 60 秒等待，下次必須由使用者手動啟動新測試；首次實測是在加入等待前完成，加入等待後沒有重新呼叫校方。等待及等待中取消經單元與 mock 驗收。
- 校方結果只代表該次環境，非官方上限／長期保證。Windows／Linux 真人校方 SSO 尚未實測；本版 CI 結果見 Actions。


## 0.6.1 介面與任務對話清理（2026-10-14）

- 100 個單元測試通過，包含自建 session identity 的觀察、不傳出憑證／提問內容、子任務本機保存失敗時保留校方對話。
- 真實 Chrome localhost mock：自建對話刪除成功，原有對話未操作；HTTP 503 刪除失敗保留歸屬，後續明確清理成功。重新開啟 Profile 後仍能載入模擬歷史及清理；登入、串流、附件、取消與並行回歸通過。
- UI fixture：聊天標題與設定同列、專案位於輸入框下方、地球提示、AI4X 範例只填入而不送出，變更／子任務按鈕回歸通過；README 三張圖由實際側欄程式與示範資料產生。
- macOS／Chrome／真實 NTPU AI：主 Agent 分派探索與審查兩個子任務，分別讀取測試專案 HTML／JS 前十行；兩者完成並由主 Agent 收集結果、產生最終報告。主任務正常網站刪除操作成功，本機聊天與工具紀錄仍可讀，未觀察到清理失敗通知。這是 HTTP 刪除成功的驗收，不是校方後端備份抹除證明。
- Windows x64、macOS arm64／x64、Linux x64 的 Node 20／22 [八項 CI 工作全通過](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38441510151)。Windows／Linux 真人校方 SSO 尚未實測。


## 0.6.0 變更檢視與並行（2026-10-14）

- macOS arm64／Chrome／已登入的真實學校帳號：兩個獨立 Page 經正常網站 UI 同時送出請求，回覆各自識別碼且沒有另一個識別碼；耗時 4.50 秒及 4.21 秒，SSE 開啟至結束的區間重疊約 129 ms。測試完成時間 01:04:10（Asia/Taipei）。僅證明這次兩個串流重疊，不能推論推理硬體並行或速度提升比例。
- 測試紀錄只包含時間、匹配結果、網站／Profile scope 雜湊，不保存原始回答或登入憑證；存於私有 globalStorage diagnostics。
- AI4X 真實 MCP 連線取得 11 個工具，`get_center_info` 與 `search_services` 實際呼叫成功，資料帶官方來源。校務 Assistant 仍是官方網頁入口。
- 98 個單元測試通過，涵蓋檔案／區段撤回、後續手動修改衝突、新檔案回收桶、並行讀取、唯讀 worker、實際 worker 工具迴圈、父任務收集證據、共用預算、單請求退回、限流取消與核准佇列。
- 本機 VS Code 已安裝 0.6.0 並重新載入；原有聊天記錄與背景登入保留，多工驗證狀態可見；歷史檔案變更可展開保留／撤回檔案及區段，未改動使用者檔案。
- localhost 真實 Chrome fixture 涵蓋同時串流／回覆隔離、停止子聊天室不影響主聊天室、聊天室關閉清理，以及登入接續、附件與側欄互動。
- Windows x64、macOS arm64／x64、Linux x64 的 Node 20／22 [八項 CI 工作全部通過](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38437760641)，四平台 VSIX 的版本、TargetPlatform 與 Agent 來源均已確認（Windows 比對忽略 CRLF 差異）。Windows／Linux 的真人校方 SSO、長時間負載與學校端複雜子任務分工尚未實測；子任務 orchestration 目前有本機 mock 模型回覆驗收，真實學校端驗收範圍是兩個聊天室的有限請求。


## 0.5.4 登入視窗與背景接續（2026-10-14）

- macOS Apple Silicon／Google Chrome：80 個單元測試通過；正常尺寸的原生登入視窗、成功提示與返回按鈕可見。
- localhost 真實瀏覽器 mock：HttpOnly session Cookie 沒有到期時間，完成登入後可由相同 Profile 還原；按返回按鈕、直接關窗、倒數自動關窗後皆能以背景瀏覽器繼續串流回覆。
- 登入前關窗不誤報成功、不反覆彈窗；自動背景還原不自行開視窗；人工按「登入」才開啟正常瀏覽器。
- UI、聊天記錄、附件、停止及任務內對話重用回歸；Profile 與本機 Session／Project Memory 維持原儲存路徑。
- GitHub Actions 涵蓋四平台／Node 20 與 22。Linux 使用 Xvfb 驗證登入視窗；各版本結果可在 [Actions](https://github.com/xujk0217/ntpu-ai-vscode/actions) 核對。
- 本版未重新人工驗收校方 SSO／CAPTCHA，也未呼叫真實 NTPU AI 模型；上述 mock 證據不等同校方登入相容性。

以下為前版歷史驗證紀錄。

日期：2026-10-13（Asia/Taipei）。環境：macOS Apple Silicon、Chrome、VS Code、已登入的 NTPU 學校帳號。工作區：`examples/local-demo`。

## 實際功能

- 0.1.1：由模型建立 `add.js`，經 diff 核准寫入，再讀取並改成 `add(...values)`。核准 Node 指令後得到 `ADD_OK`。更新／重新載入可沿用專用 Chrome 的已登入狀態。
- 0.2.0 候選版：新版 Agent 側欄實際載入並沿用登入。Research 提出 `web_search`，核准一次查詢後連上 Exa MCP，搜尋 MDN，回答空陣列未提供 initialValue 時的 TypeError，附兩個 MDN 連結。
- 獨立 Exa 連線取得 `web_search_exa`、`web_fetch_exa` 工具，實際搜尋成功。
- Build 呼叫 `create_visual`，核准後產生 `agent-visual.png`，1024 × 768、白底藍色圓形，15127 bytes；已開啟確認。
- 同一工作呼叫 `inspect_image` 上傳 `vision-fixture.png`，辨識出「NTPU VISION 42」、紅色正方形與綠色三角形；提問沒有提供這些文字、形狀或顏色。
- 0.2.1 修正候選版圖片資源 URI 預覽問題，改用縮圖資料；加入檢視／另存圖片、加入 skills 目錄、連線進度與圖片變更列。

## 程式檢查紀錄

0.2.0 候選版已有 22 項測試通過，涵蓋：

- 工作區與符號連結限制、秘密檔案、分段讀檔與工具協定。
- 串流 SSE、停止與核准綁定。
- 三種權限、唯讀 Agent 限制、skills 路徑、工作階段還原。
- SVG 轉 PNG、危險 SVG 拒絕與私人網路位址拒絕。
- 真正 stdio MCP transport 啟動本地 fixture、列出工具並取得實際 echo 結果。
- mock VS Code API 的局部修改、保留未讀內容、核准期間衝突拒絕與唯讀寫入拒絕。

這些測試不是大型專案正確性或所有 MCP 相容性的保證；0.2.1 最後介面與 metadata 修正另以打包及原生 UI 確認。

## 0.2.x 時尚未驗證

Windows／Linux／Intel Mac、大專案、訪客用量、全部第三方 MCP、付費照片型生圖、所有 PDF 模型路由、工作區多視窗並行。

NTPU 公開網頁目前未提供原生 thinking／reasoning_effort 或任意模型切換；快速／標準／深入是本地 Agent 策略及工具輪數設定。

## 0.2.1 安裝後確認

- 成功產生 macOS arm64 VSIX（23.66 MB），VS Code CLI 回報安裝成功。
- 重新載入範例視窗後，研究與圖片兩個工作階段均保留，權限恢復為要求核准。
- 白底藍色圓形縮圖已在新版側欄直接顯示；「檢視圖片」成功開啟 VS Code 圖片編輯器。
- Skills 面板實際列出四個內建技能與加入資料夾入口。
- MCP 面板實際連接 Exa，顯示 2 個工具；新增及匯入設定入口可見。

## 0.3.1 Agent 與 UI 核對

- 35 項主機測試全部通過，新增格式修復、拒絕僅輸出程式碼、未完成計畫要求繼續、唯讀規劃可結束、檢查點續跑及指令規則測試。
- 真正 shell 程序驗證：預設 `pwd` 無核准執行並串流輸出；自訂 `node task.js` 規則取得 ACTUAL_COMMAND_OK；改為 false 後要求核准。
- 0.3.0 原生候選版由 NTPU 模型收到一個完整實作任務後，自行探索專案、讀 add.js、建立 stats.js／stats.test.js、讀取確認、執行 node --version 與 node --test、更新計畫並提供結果，共 10 次工具操作。檔案寫入與測試指令依預設權限單次核准，基本版本指令自動執行。
- stats.test.js 的平均值、負數、空陣列三個案例全部通過，退出碼 0；任務進度 4/4。原生 UI 展開「已執行」列可看到相同實際輸出。
- 發現並修正首次開啟 Chrome 時，DOM 已載入但既有登入尚未恢復的時序問題；改為等待正常網頁登入狀態，不代解驗證。
- 最後修正補上主機開始工作的簡短說明、儲存後的事實進度、核准來源與含等待的耗時標示。

上述實際模型任務確認多步流程可運作，不代表所有模型輸出都能正確完成任意任務。0.3.1 最終安裝與 UI 確認另見後續記錄。

## 0.3.1 最終安裝確認

- 最終 VSIX 已安裝成功，重新載入範例工作區後保留完整任務與 4/4 進度。
- 新工作階段未先按連線，直接要求執行 node --version。專用 Chrome 自動恢復既有登入，首次提問成功，未再出現過早的登入錯誤。
- UI 顯示主機的簡短開始說明、「已執行 node --version」灰色折疊列；指令未要求核准，模型回報真實 v20.20.2。
- 最終本地測試 35/35 通過；另直接執行產出的 stats.test.js，3/3 通過。
- GitHub 儲存庫為 public，協作權限查詢只列出 xujk0217；所有提交僅使用使用者作者身份與 GitHub noreply 信箱。

## 0.4.0 Local-first／防護／跨平台

- 本機 macOS arm64：依賴安裝、build、59 項 tests、VSIX、真實 Chrome headed／headless localhost fixture 通過。
- [CI 38393599933](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38393599933)，commit `931e5f7`：Windows x64／macOS arm64／macOS x64／Ubuntu x64，Node 20／22 共 8 工作全部成功。
- 四平台真實 headless Edge／Chrome／Chromium 控制、串流、附件、取消、合成登入狀態 profile 保存、Webview、原生 sharp 與 VSIX 通過。
- 測試使用 localhost／Mock BrowserBridge／假憑證，此輪沒有真正 NTPU AI 推論或 SSO。
- 磁碟記憶／遷移／衝突／備份、跨帳號 mock 接續、敏感路徑與 stdout／MCP／Editor／保存遮蔽的細節，以及尚未驗證的平台與沙箱限制，見 [重構交付與驗收](docs/REFACTOR_REPORT.md)。

## 0.4.1 最終驗收

- Cookie 集合／標頭回歸防護完成，本機 60／60 tests、build、Chrome localhost fixture、VSIX 成功。
- [CI 38395852343](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38395852343)，code commit `56c60e9`：四平台 × Node 20／22 全部 8／8 工作成功，各 60 項測試、build、瀏覽器 fixture、sharp 自檢及 VSIX。
- VS Code CLI 確認本機版本 0.4.1；範例視窗重新載入後，原對話仍可離線查看，Browser 與 Memory／Privacy 頁正常。沒有重新登入或真正 NTPU AI 請求。
- 目標原生 binary 與私有目錄排除另以 VSIX ZIP 檢查；公開套件及校驗碼見 [0.4.1 Release](https://github.com/xujk0217/ntpu-ai-vscode/releases/tag/v0.4.1)。

## 0.4.2 聊天紀錄管理

65／65 本機 tests、build、Chrome localhost 列表 fixture、VSIX 成功。原生 VS Code 重新載入範例視窗後確認聊天紀錄、勾選、批次按鈕與每筆 ⋯ 選單。code commit `75eeb7c` 的 [CI 38398505182](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38398505182) 四平台 × Node 20／22 全部 8／8 成功，各 65 項測試、build、真實瀏覽器 localhost／Webview fixture、sharp 自檢與 VSIX；全程沒有真正 NTPU AI 請求。

## 0.5.0 開發驗收（2026-10-13，Mac arm64）

- 78 個單元／整合測試通過；涵蓋 OCR 末頁秘密、缺頁、清理、SSO HTTPS 面板輸入與忙碌鎖定。
- 真實 Chrome localhost Mock：側欄畫面、輸入、設定分區、串流、附件、取消與 Profile 保留通過。
- 真實 macOS Seatbelt：工作區外檔案及 `.env` 讀取禁止，工作區寫入允許；運作中的 localhost HTTP 不可存取，stdio MCP 初始化／工具呼叫通過。
- 真實 Tesseract／Poppler：乾淨圖片／PDF 通過，合成憑證圖片／PDF 拒絕，原文不保存。
- 真正 NTPU 背景模式還原既有登入並產生畫面；本輪 Agent 任務在背景及原生視窗皆收到 HTTP 502。未重做全新 SSO／CAPTCHA。
- Windows Shell／stdio 仍阻止執行。Windows、Linux、Intel Mac 桌面 SSO 尚待人工驗收。新多平台 CI 結果需另行確認。
- 依賴弱點與 OCR 漏辨範圍見 [安全實作說明](docs/BROWSER_SURFACE_AND_SECURITY.md)。

最終 CI：[38415167553](https://github.com/xujk0217/ntpu-ai-vscode/actions/runs/38415167553)，程式碼 `4aab9276e898e503912048e5a7d331195692d21d`，8／8 工作成功。Node 22 的 macOS arm64／x64 與 Linux 原生 OS 沙箱／stdio MCP／OCR 通過；四平台產生原生 VSIX。這不等於學校 SSO 或 Windows 沙箱已驗收。
