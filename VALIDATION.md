# 本地使用驗證

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
