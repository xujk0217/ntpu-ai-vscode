# 0.6.20 本機驗證紀錄

日期：2026-10-16。本機 Ubuntu 24.04 Linux x64、非 root；本次沒有改動 Session、Checkpoint、聊天／Project Memory 或校方專用 Profile，沒有更改使用者核准設定。

- `npm test`：407／407 通過，包含既有的聊天持久化、核准、工具、MCP、子任務、脈絡與長文回歸。
- 新增 19 個能力擴充測試：固定官方來源／游標分頁／最新版本與 TTL、來源變更／私有 DNS／未知候選拒絕、headers／套件需求不執行、網路關閉／唯讀子任務／完整存取仍需核准、拒絕／取消／401／429、不重複查詢、保存失敗回復、實際工具限流停止，以及未查證結語攔截。
- 真正 HTTP MCP fixture：受控模型從空工具搜尋、自動 Registry 候選、核准、MCP SDK 握手及兩頁 tools/list、完整 schema、實際 tools/call，到根據真實結果完成原任務；沒有把 URL 開啟或假 catalog 當作自動化成功。
- 取消測試使用真正的 HTTP initialize 連線，由 AbortSignal 中斷 transport，確認沒有發布 connection 或 tools。沒有透過取消某個測試掩蓋 Windows 清理錯誤。
- 最低 16,000 字元脈絡測試通過。小預算改用較短分工說明，工具規格仍可完整分頁讀取，沒有放寬子 Agent、預算或權限限制。

既有 localhost browser fixture（登入視窗／背景交接、session-cookie 持久化、串流、分段長文、附件、取消、記憶／設定 UI）通過；獨立工作瀏覽器 fixture 亦通過。Linux 真實 bubblewrap 檔案／網路隔離與 stdio MCP，以及真實 Tesseract／Poppler 乾淨資料／合成憑證辨識通過。後兩項沿用先前獨立驗證工具路徑，沒有冒充系統已安裝或改動使用者設定。

## 實際官方 Registry 查詢

正式程式（`src/mcp-registry.js`）透過固定官方 HTTPS 來源搜尋 `pdf`，取得 9 筆最新有效候選及後續頁游標，包含 `review_connection` 與 `requires_configuration` 狀態。只傳送能力關鍵字；沒有連接這些第三方 MCP、沒有新增本機設定、沒有上傳私人檔案、沒有發出校方模型請求。

調查時 `search` 與 `version=latest` 的複合查詢在 Node／Python 測試均逾時；單獨名稱查詢可成功，`/servers/<name>/versions/latest` 也可成功。修正後不合併慢參數，先看官方 `isLatest`，若整頁只有歷史版本則有界查詢個別名稱的 latest。這是本機實測的相容處理，未宣稱已確認官方服務的內部原因。仍保留每次二十秒截止、1.5 MiB 上限與來源不重新導向；服務慢或離線會明確回報，不能解讀成沒有工具。

## 範圍

本版可擴充公開 HTTPS／SSE MCP；固定版本、真實握手及完整 metadata 驗證後才保存設定。工具是否成功另以真實呼叫結果記錄，後續失敗會清除成功驗證狀態。

Registry 收錄不是安全背書。金鑰／headers／樣板 URL 或本機 npm、PyPI、OCI 等套件仍會列出安全設定需求，不任意安裝或執行。SecretStorage、原有 stdio OS 沙箱及 Windows stdio 未啟用的限制保留。設定頁需要先結束／停止任務，再由使用者安全設定後於原聊天繼續。

真人 NTPU 模型選擇候選並由使用者核准的端到端流程、需要帳號的第三方 MCP 及所有 Registry server 尚未真人驗收。這次實際服務讀取只限公開目錄；完整工具循環以 localhost 真實協定 fixture 驗證。

四平台 × Node 20／22 的當版 CI、原生打包及公開資產校驗以 v0.6.20 Release／Actions 為準；只有八組全過，發布流程才會將草稿轉為正式版本。
