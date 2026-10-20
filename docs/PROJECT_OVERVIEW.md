# 專案架構概覽

此頁依 0.6.22 的發布原始碼及 0.6.23 的附件、聊天介面調整整理。涵蓋擴充套件入口、Agent 迴圈、網站橋接、工具、記憶、權限、Plugin 與打包流程；不將第三方依賴或歷史驗收結果當成當前能力保證。

## 模組與責任

| 模組 | 責任 |
| --- | --- |
| `src/main.js`、`src/app.js` | VS Code 命令與側欄、聊天工作階段、任務狀態、附件、核准與停止清理。 |
| `src/agent.js`、`src/protocol.js` | 組裝模型輸入、解析單一操作封裝、執行工具、保存證據、檢查完成條件及有界恢復。模型列出程式碼不等於寫入成功。 |
| `src/agent-workers.js`、`src/delegation.js` | 評估可獨立分派的唯讀工作，收集探索、研究、審查結果；主 Agent 負責整合與修改。 |
| `src/parallel.js`、`src/adaptive-concurrency.js`、`src/request-rate.js` | 共用模型預算、FIFO 排隊、請求節奏與 1–4 動態名額；子 Agent 名額上限為四個。 |
| `src/browser.js`、`src/browser/` | 偵測並控制 Chromium 系瀏覽器、專用 Profile、真人登入交接、觀察網站 SSE 串流、附件上傳、取消與對話清理。 |
| `src/tools.js`、`src/workspace.js`、`src/change-review.js` | 專案檔案讀寫、搜尋、Shell、網路、圖片與文件工具，以及變更快照、差異與撤回。 |
| `src/mcp.js`、`src/tool-discovery.js`、`src/mcp-registry.js`、`src/mcp-registration.js` | 完整工具目錄分頁、按需載入規格、Registry 候選審查，以及核准後的真實連線與工具驗證。 |
| `src/skills.js`、`skills/` | 探索及載入 `SKILL.md` 任務指引；Skill 不授予工具權限。 |
| `src/memory/`、`src/sessions.js`、`src/output-parts.js` | 本機工作階段、專案記憶、完整歷史、長文分段、輸入脈絡整理與檢查點。 |
| `src/permissions.js`、`src/approval*.js`、`src/security/` | 核准模式、拒絕紀錄、敏感路徑、秘密遮蔽、附件 OCR，以及支援平台上的 OS 隔離。 |
| `src/computer/` | 限定目標、逐次核准、操作後重新觀察的工作瀏覽器；Linux 有受限制的 X11／XWayland 後端；macOS 14+ 有 ScreenCaptureKit／AX 單一視窗後端。 |
| `src/plugin/`、`plugins/ntpu-ai/` | 明確啟用的本機分析橋接與可攜 stdio MCP；外部 Agent 不繼承目前聊天、Project Memory 或本機工具。 |
| `src/updates.js`、`src/updates-vscode.js` | GitHub Release 檢查、平台選包、下載校驗、VSIX 身分檢查與 VS Code 安裝。 |
| `media/` | 真實 Webview 介面、Markdown／公式顯示、聊天列表、任務紀錄、核准與設定。 |

## 一次任務如何運作

1. 使用者選擇本機工作區與 Agent 模式，輸入需求。背景網站連線在需要時確認登入；模型不會直接取得整台電腦權限。
2. 本機主機整理同聊天室歷史、相關專案記憶、先前證據與工具目錄，送入校方網站的新對話。
3. 模型回傳下一個工具、分工評估、文件段落或結語。主機檢查格式、模式、路徑及核准，再執行實際操作。
4. 工具結果回寫本機，成為下一輪證據。可獨立的子任務使用自己的網站通道，但共用模型排程、節奏與輪數。
5. 主機檢查未完成計畫、失敗操作、子任務與畫面驗證，再決定完成或保留檢查點。取消、拒絕、服務限制與本機保存失敗均需尊重。

一般失敗可以在有限次數內恢復，不能保證所有任務都能完成。模型長時間無內容進展與持續串流分開判斷，單次請求仍有總期限；429、登入失效或明確服務限制不會被換聊天室繞過。

## 資料保存與外部傳送

- 本機記憶是 VS Code 私有儲存區中的版本化 **JSON 檔案**，包含 sessions、projects、backups 與 conflicts；不是 SQLite 或向量資料庫。
- 完整原文在本機保存，模型每輪只收到依字元預算整理的內容。歷史或工具證據不能視為目前檔案的即時狀態。
- 主動選取附件即視為該次附件傳送意圖，不再另跳通用警告。讀取真實路徑、容量與型態檢查、OCR 及已知秘密檢查仍在附件就緒前執行。
- 傳給 NTPU AI 的文字、附件與工具結果仍會進入校方服務；Exa 與其他 MCP 也有自己的資料目的地。Local-first 描述保存方式，不代表離線模型。
- 網站登入留在專用 Profile；MCP 憑證使用 SecretStorage。切換瀏覽器或更新擴充套件不會刻意刪除本機記憶。
- 整份聊天記錄的 Markdown 匯出已移除；本機保存與管理持續運作。單一生成文件另存、圖片另存及記憶備份屬於各自的操作。

## 平台與能力邊界

Windows x64、macOS arm64／x64、Linux x64 使用共用 Agent 核心與各平台原生 VSIX。Windows Shell／stdio MCP 仍未啟用；macOS 與 Linux 需相符的 Node 執行期與 OS 隔離相依環境。Computer Use 的工作瀏覽器不等同完整桌面控制，原生桌面支援 Linux X11／XWayland 與 macOS 14+ 可核對的 AX 控制項；Windows／原生 Wayland 仍待辦。Remote SSH、WSL 或 Container 不能假定可存取本機桌面。

完整限制與驗收進度見[平台對照](PLATFORM_PARITY.md)。

## 建置與發布

`npm run build` 建置 Webview 與 Plugin bundle；VSIX 因含 sharp 原生依賴，須在對應 OS／架構打包。CI 對四種原生套件目標執行 Node 20／22 測試與 build，再由 Node 22 工作產生安裝包。發布工作核對已測提交、版本、套件內容、原生平台與 SHA-256，最後公開四種 VSIX、Plugin ZIP 及校驗碼。

自動化 CI 與 localhost 畫面測試不代表真人校方 SSO、所有第三方 MCP 或所有作業系統功能均已完成實機驗收。
