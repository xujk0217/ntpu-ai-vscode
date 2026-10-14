# NTPU AI Agent

NTPU AI Agent 是使用 NTPU AI 網站模型的 VS Code 擴充套件，提供本機專案讀取、檔案修改、工具執行、研究查詢及可接續的 Agent 任務。模型透過專用瀏覽器連線；登入由使用者完成，日常運作使用背景瀏覽器。

**版本：0.6.2 · 實驗性專案 · MIT License**

本專案為第三方工具，與國立臺北大學、Microsoft、OpenAI 及其他參考專案無隸屬或官方背書關係。使用資格、驗證、用量與資料處理仍受校方服務政策約束。

## 介面

以下截圖由實際側欄程式產生，內容為本機測試範例。

<img src="docs/images/chat.png" alt="聊天與 Agent 任務介面" width="380">

聊天標題與設定入口位於同一列；專案資料夾位於輸入框下方。工具與子任務以可展開的執行紀錄呈現，檔案變更提供整份檔案及個別區段的保留／撤回操作。

<img src="docs/images/changes.png" alt="檔案與區段變更檢視" width="380">

## 安裝與更新

目前透過 GitHub Releases 提供 VSIX，尚未上架 VS Code Marketplace。

1. 安裝 VS Code 1.95 以上，以及 Chrome、Edge 或其他受支援的 Chromium 瀏覽器。
2. 從 [0.6.2 Releases](https://github.com/xujk0217/ntpu-ai-vscode/releases/tag/v0.6.2) 下載符合系統的安裝檔。
3. 在 VS Code 擴充套件頁的 `…` 選單選擇 **Install from VSIX…**，安裝後重新載入視窗。
4. 開啟專案，進入 **NTPU AI** 側欄，按 **登入**，人工完成校方登入或驗證。成功後可關閉登入視窗，擴充套件會接續背景連線。

| 平台 | 安裝檔 |
| --- | --- |
| Windows x64 | `ntpu-ai-coder-win32-x64-0.6.2.vsix` |
| macOS Apple Silicon | `ntpu-ai-coder-darwin-arm64-0.6.2.vsix` |
| macOS Intel | `ntpu-ai-coder-darwin-x64-0.6.2.vsix` |
| Linux x64，glibc | `ntpu-ai-coder-linux-x64-0.6.2.vsix` |

更新時安裝新版 VSIX 並重新載入即可。既有本機聊天、Project Memory 與專用 Browser Profile 沿用原儲存位置。Remote SSH、Dev Container、WSL 必須區分本機 UI Extension Host 與遠端工作區；不能假設遠端主機具備本機桌面瀏覽器。

## 使用方式

### Agent 任務與權限

在輸入框描述預期結果，例如「檢查專案入口並修正錯誤，完成後執行測試」。Build 可實作；Plan、Review、Research、Ask 用於唯讀規劃、審查、研究與問答。

- **要求核准**：專案讀取與辨識出的基本唯讀指令自動執行；修改及其他操作需確認。
- **協助核准**：工作區修改及公開搜尋可自動執行，其他指令與敏感操作仍需確認。
- **完整存取**：允許範圍內的工具自動執行；敏感檔案政策、OS 執行隔離與唯讀 Agent 限制仍有效。

Agent 會依任務選用工具、載入適用 skills，並評估是否分派探索、研究或審查子任務。子任務只能讀取，主 Agent 負責整合、修改與執行 Shell。單純提問通常直接處理；可在設定關閉多工或限制為一個模型請求。子任務上限可設為自動或 1–5，受有效模型並行數限制；自動模式保留主任務的請求空間。

設定 → 工具可逐組測試 2、3、4、5 個同時請求；每組使用新的獨立聊天室，記錄成功率、回應／首字時間、串流峰值及錯誤。只有完整成功、未串台且全組串流確實重疊，才提高已驗證數。排程器依最近 24 小時、同一網站／Profile 的有效結果自動設定上限；可手動調低，不可超出驗證。遇到登入／429／其他服務限制或停止測試會降級為 1，不自動重試。完整測試最多 14 個小型請求，成功組之間預設等待 60 秒，降低短時間累積請求觸發頻率限制的機率；失敗後不自動等待重試。這只是當次環境結果，不是官方保證的上限。父子任務共用模型輪數預算，不會透過多工繞過校方限制。進度 `5/50` 表示目前任務的模型回合數與上限。

### 網路搜尋、AI4X 與 Skills

地球按鈕控制 **Exa 網路搜尋及公開網頁讀取**，不是開啟瀏覽器，也不是 AI4X 的開關。工具提示會顯示目前開關狀態與用途。

<img src="docs/images/tools.png" alt="工具與官方研究資料設定" width="380">

[NTPU AI4X MCP](https://ai4x.mcp.ntpu.ai/) 提供官方研究資料的 11 個工具。連線後直接提問，Agent 自行選用工具；亦可透過內建 `ntpu_lookup` 按需連線。設定 → 工具提供可填入聊天的範例：

- 「請查詢 NTPU AI4X 的中心資訊與合作服務，附官方來源。」
- 「請用 AI4X 找出與人工智慧相關的研究專家及公開計畫，附官方來源。」

AI4X 涵蓋中心資訊、服務、成員、研究專家、計畫、公開文件與活動；對外傳送查詢參數仍需依權限確認。[NTPU AI Assistant](https://aia.ntpu.ai/) 則提供官方校務問答，設定頁提供網站入口，未將其當成 MCP 或未公開 API。

Skills 是任務指引，不能授予權限。選擇 skills 代表預先載入；Agent 也能依需求使用 `load_skill` 載入其他已發現的技能。分析深度調整本機規劃策略，並非 NTPU 模型原生 thinking 參數。

### 聊天記錄與對話清理

歷史頁預設只顯示聊天標題、時間等基本資訊，點選直接進入對話。右上 **編輯** 才顯示多選、封存、刪除等管理操作；批次刪除前會確認。按 **完成** 或離開面板會清除選取並恢復一般列表。

<img src="docs/images/history-normal.png" alt="歷史聊天一般列表" width="340">
<img src="docs/images/history-edit.png" alt="歷史聊天編輯與多選" width="340">


完整聊天、工具結果、修改快照與 Task Checkpoint 儲存在本機 `globalStorageUri/agent-memory`，格式為有 Schema 版本的 **JSON snapshots**，不是 SQLite。Project Memory 另存於專案記憶檔；使用原子寫入、寫入佇列及跨視窗鎖。設定 → 記憶可查看實際位置，聊天列表可搜尋、重新命名、封存、匯出及刪除。

任務內容仍會傳給校方模型，使用外部工具時也會傳送所需參數；本機保存不代表校方伺服器未收到或未保留資料。

任務紀錄成功存入本機後，擴充套件透過校方網站的正常刪除按鈕，清理自己建立的臨時任務對話，包括子任務對話。原有網頁對話不在清理範圍。清理失敗會顯示通知，不能保證移除校方後端、稽核或備份資料。可使用 `ntpuAI.browser.cleanupTaskConversations` 停用；此設定需要重新載入以套用。

## 安全性與驗證範圍

- 使用獨立 Browser Profile，不匯出 Cookie、Token 或驗證憑證，不繞過 SSO、CAPTCHA 或用量限制。
- 檔案工具限制在選定工作區，保護敏感路徑及憑證；撤回前檢查後續修改，避免覆蓋使用者內容。
- Shell／stdio MCP 需要受支援的 OS 隔離；缺少隔離時拒絕執行。Windows 完整 OS 沙箱仍待驗收。
- 圖片／PDF 在上傳前使用本機 OCR 與文字檢查；需要 Tesseract／Poppler，辨識仍可能漏判，請自行確認附件內容。
- macOS／Chrome 此次快速測試中，2、3、4 個請求均成功且全組串流重疊；5 個時遇到「每分鐘最多 10 題」的 HTTP 429，立即停止並降為 1，因此 5 個能力尚未確認，這不是並行上限判定。後續手動測試預設增加組間間隔；Windows／Linux 真人校方 SSO 尚待驗收。並行測試不保證速度提升或校方永久支援。

詳細結果見 [驗證紀錄](VALIDATION.md) 及 [GitHub Actions](https://github.com/xujk0217/ntpu-ai-vscode/actions)。

## 開發、文件與授權

- [完整操作與設定手冊](docs/USER_GUIDE.md)
- [開發與問題回報](CONTRIBUTING.md)
- [更新紀錄](CHANGELOG.md)
- [安全回報](SECURITY.md)
- [使用規範](docs/USAGE_TERMS.md)
- [第三方授權與參考來源](THIRD_PARTY_NOTICES.md)

本專案原創程式碼採 [MIT License](LICENSE)。隨附依賴保留各自授權；校方服務權利與資料政策不受本專案授權變更。分工設計參考 oh-my-openagent 的概念，由本專案自行實作，未複製其原始碼。
