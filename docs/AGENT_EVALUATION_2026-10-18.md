# Linux 真實開發情境調查（2026-10-18）

## 方法與可重現資料

基準為 0.6.20、`4c1da3c`，Ubuntu 24.04.4 x64、Node 24.21.0、Google Chrome 155.0.8059.79。Playwright 使用擴充套件自己的 Chrome Profile，確認既有學校登入有效，經網站正常 UI 送出模型請求並觀察 SSE；沒有呼叫模型官方 API、讀取日常 Profile、匯出登入憑證或修改個人聊天與 Project Memory。

驗收程式位於本機 `.local/evaluation-20261018/run.js`，證據與三個獨立工作區位於 `/home/xujunkai/Developer/ntpu-agent-evaluation-20261018`。程式使用真實 `runAgent`、`WorkspaceTools`、`AgentWorkers`、`RequestScheduler`、`ModelBudget`、`RequestRateGate`、`BrowserBridge` 與 Linux bubblewrap。只有 VS Code 的文件編輯／檔案列舉 API 由落地到磁碟的 adapter 提供；不是聊天面板逐項點擊驗收，也沒有讀取使用者的 Session。

初次核心測試與記帳接續使用 `core-run.js`；後續預約／庫存接續改走 `run-app.js` 的真實 `AgentApp.ask()`，包含 SessionStore／ContextManager、共用核准偏好、App 的任務狀態與校方對話清理。App 測試使用私有的合成 globalStorage、64,000 字元與 100 輪、關閉自動 Project Memory 更新並使用手動聊天名稱；因此沒有涵蓋取名請求或個人既有記憶內容。核心控制組使用 48,000 字元與固定兩個請求名額，不能將其效能數值直接等同預設 App 動態並行的效能。

## VS Code 是否重用同一份校方對話

直接讀取 VS Code `extensions.json` 註冊位置，確認為 `ntpu-local.ntpu-ai-coder-0.6.20`，而非只根據原始碼版本推測安裝版。該安裝版的 `src/app.js` 呼叫 `runAgent`；`src/agent.js:147` 明確指定 `newConversation:true`；`src/browser.js:304` 在每輪點擊 `#newChatBtn`。取名與畫面分析的模型請求也另開校方對話。

**專用 browser context／page 會重用，但校方 conversation 每輪更換；VS Code 本機聊天室則保留完整歷史，重新組裝需要的上下文。** 這三層不能混為一談。接續測試另外比較請求前後本工具擁有的對話集合，只記錄 `newConversationObserved` 布林值，不記錄 session ID；可用此實際觀察檢查按鈕是否真的產生新對話，而非只相信原始碼呼叫。此結論適用本機註冊版本，不能回推未知舊版本。

各請求閒置期限設為 **600 秒**，共用每分鐘 8 次節奏、最多兩個並行模型請求及兩個唯讀子任務。初次探測以 40 輪共用模型預算觀察停止行為；若未完成，以已保存檢查點與正式預設的 100 輪預算接續。此預算與 600 秒等待期限是不同限制。

沙箱使用已存在的 `/usr/bin/bwrap`；此主機 PATH 沒有 socat，測試明確使用先前驗證用 `/tmp/ntpu-validation-tools/ubuntu/usr/bin/socat` 及其動態函式庫。這不代表已替 VS Code 系統安裝 socat，亦不代表 Snap Extension Host 的環境已通過相同驗證。未降低 Chromium 或 shell 沙箱保護。

三個場景均限 Node.js 內建模組，不安裝外部依賴，不讓產生的程式連網：

1. 記帳 CLI：CSV 引號、CRLF、整數分、退款、月份／分類統計、拒絕錯誤列。
2. 預約系統：資源、UTC 起訖、相鄰時段、衝突、取消、跨日、JSON 保存與 CLI。
3. 庫存／訂單：保留、扣庫存、取消釋放、冪等確認、失敗原子性、JSON 保存與 CLI。

每筆請求記錄送出、HTTP 串流開啟、模型選擇事件、第一個 token、結束、內容字元數及工具結果。SSE 診斷不含 prompt／回覆本文；僅此合成專案的工具與檢查點另存於本機證據目錄。遇到登入失效、429 或服務限制立即停止，不以重試繞過。

## 實測結果

約 31 分鐘的模型開發測試，合計 **150/150 筆請求收到非空內容與正常完成事件**；沒有 HTTP 429、登入失效、空回答、串流中斷或模型逾時。最長首字等待 **61.166 秒**，最長整輪 **95.873 秒**。因此本次**沒有證據證明原問題由 240 秒提早切斷造成**，也不能宣稱此問題在其他時段已不存在。600 秒用在真實測試的等待設定；第 450／600／900 秒邊界另以模擬時鐘驗證，不能混稱真人網站測試。

| 場景 | 初次＋接續模型請求 | 最長單輪 | 獨立直跑 node --test | 額外獨立斷言 | 任務最終狀態 |
| --- | ---: | ---: | ---: | ---: | --- |
| 記帳 CLI | 40＋9 | 38.682 秒 | 16/16 | 8/8 | 未完成：XML 工具格式錯誤，README 未寫入 |
| 預約衝突檢查器 | 40＋8 | 50.169 秒 | 10/10 | 8/8 | 未完成：App 路徑也遇 XML 格式錯誤，README 未寫入 |
| 庫存與訂單 | 40＋13 | 95.873 秒 | 11/11 | 9/9 | 未完成：暫存目錄失敗經 Agent 調查修正測試後通過，之後仍遇格式停止 |

表中的測試與斷言是在完成三次嘗試後，另以真正 bubblewrap、直接 `node --test`（沒有 `tail` 管線）重跑；回傳退出碼均為 0。獨立斷言包含 CSV 精確金額／引號／退款與錯誤列、預約跨日／相鄰／衝突／不可變性、庫存原子性／冪等／取消／保存往返。這些證據證明產生的核心功能在這些案例可用，**不代表三個專案已經端到端完成**；沒有替 Agent 補寫遺漏的 README 來掩蓋失敗。

接續的 30 筆請求均實際觀察到新校方對話，重用觀察為 0；其中預約／庫存由真正 `AgentApp.ask()` 發起。App 清理分別刪除其擁有的 8／13 個測試對話，失敗數均為 0，耗時約 6／9 秒；本機合成 Session 與 checkpoint 仍保存。

一項測試介面干擾需排除：App 接續模板原本誤把「允許合成 sample.csv」也帶到非記帳場景，庫存 Agent 因此新增 CSV 樣本步驟。這是測試者提供的多餘引導，不能當成 Agent 自行偏離任務的證據。已修正重跑腳本，僅記帳場景帶入該許可；上述實測保留原始紀錄，沒有冒稱重新跑過修正模板。兩個非 CSV 場景與記帳的共同 XML 格式問題仍有各自獨立收據。

## 已確認的行為與修正

- 600 秒設定針對「沒有新回答內容」，不是整個開發任務的總長。單次請求仍有最多 15 分鐘總期限；多輪任務可超過此時間。
- 初次記帳場景用完 40 輪後回報未完成並保留檢查點；不能將此情況稱為網站逾時。多個模組與子任務共用輪數，寫後立即重讀亦會增加輪數。
- CSV 預設屬於傳送前需核准的資料。初次測試 adapter 未核准合成 `examples/sample.csv`，工具確實拒絕讀取；這不是無回應。程式原先把此拒絕包成一般 `ok:false`，漏掉 `denied:true`，使既有的相同操作拒絕記憶無法辨認。修正為保留明確拒絕標記，沒有放寬 CSV 或其他敏感資料保護。
- 增加不含本文的請求診斷：`phase` 區分 `awaiting_response`、`awaiting_content`、`streaming`；另記 HTTP 開啟／judge 時間、最後內容距今、最大內容間隔、實際閒置及總期限。時間只能說明觀察到的階段，不能單憑此斷言校方伺服器的內部根因。
- 預約場景的風險審查子任務，已保存五段、6,208 字卻仍未輸出完成段，耗盡六輪後以 `status:error` 回報。這是子任務輸出與輪數預算不相容，並非校方沒有回應。現有 `retry_task` 會重新送出原任務，沒有把前次分段作為 `initialRecords` 接續；若再次要求同樣的大報告，可能再度用完六輪。優先方案是明確限制獨立問題的範圍，並在重要長文接續時傳入已完成段與下一段序號，保留父任務驗證預算；不能直接把未完報告標成成功。
- `get_task_results` 同時帶回合併 `result`、`outputParts[].message` 與含正文的 `evidence`。本次記帳子任務約 6,748 字的審查報告，使整筆工具結果達 21,942 字元；預約場景相同結構達 19,798 字元。應保留本機完整內容，但讓模型結果只含一次正文或分段索引及可精確讀取的介面，避免同一本文重複佔用上下文。本次尚未改變該回傳契約。
- 初次預約場景有 7 次寫檔、24 次讀檔，`src/booking.js` 在沒有中間修改的情況下讀了 9 次（包含不同、重疊的行範圍）。第一筆讀檔完整回傳 172 行、未標示工具截斷；模型之後仍聲稱補讀「尚未看過」的區段。提示組裝會對舊工具紀錄另行節錄，這是可能的關聯因素，尚不能單憑事件紀錄斷定唯一成因。目前「連續三次相同工具與結果」的防重複規則無法捕捉變換行範圍或穿插其他讀檔的迴圈。建議將檔案雜湊、已看範圍與未完成驗收條件作為緊湊的持久任務狀態；偵測沒有新檔案／新證據的重複讀取時引導到測試或尚未完成的實作，不直接假設任務已完成。
- 寫後立即讀取也有 host 設計因素：`runAgent` 每輪用新校方對話，且將已執行 `write_file` 的 `args.content` 改成字數提示，寫入結果沒有包含檔案本文。模型下一輪無法從網站前文取得自己剛寫出的完整程式碼。因此不能一律把立即重讀視為模型無理由失憶。改善方向是在寫入／儲存成功的收據提供經驗證的實際文字、雜湊與行範圍，配合上下文去重；只有變更或必要缺頁才重新讀取。仍須檢查檔案是否被使用者改動，不能省略編輯前的版本一致性保護。
- 記帳以 100 輪預算接續時，9 筆模型請求後因不支援的 XML `invoke` 工具封裝停止。網站各輪均有正常完成內容，且 16 項測試和 CLI 範例已執行；模型試圖用 XML 寫 README，格式修復後仍再次發生，文件未落地。安全停止正確，但不是任務成功，更不是網站空回覆或 240 秒 timeout。改善應針對控制格式約束、最小工具 schema 與有限的專用格式修復，不任意執行 XML，也不以加長等待解決格式錯誤。
- 庫存場景的 `os.tmpdir()` 暫存建立確實失敗：`ENOENT /tmp/claude/inv-orders-...`。獨立最小 probe 在修正前得到 `TMPDIR=/tmp/claude`、退出碼 2、`TEMP_ERROR=ENOENT`。本機使用的 `@anthropic-ai/sandbox-runtime` 0.0.79 會在內層 shell 的 `generateProxyEnvVars` 將 TMPDIR 指向預設 `/tmp/claude`，覆蓋 `SandboxExecutor.prepare()` 原先提供的專用 scratch 環境變數。已在被隔離的命令起點重設 TMPDIR／TMP／TEMP 到本次已允許的 scratch，沒有修改共用 `process.env`、新增系統寫入權限、放寬網路或關閉沙箱。以 `commandText` 保留原始命令的診斷歸屬。正在進行的舊 App process 不會熱載入此修正；Agent 當時加入建立系統暫存目錄與工作區後備的測試策略後通過；紀錄不足以判定每次實際選了哪個候選。新版 host 修正由獨立真實沙箱 fixture 驗證。

## 回歸驗證

`test/response-watchdog.test.js` 用可控制時鐘驗證第 240 秒不切斷、第 450 秒首字仍可接受、完整靜默到第 600 秒才閒置逾時，以及持續有字仍受第 900 秒總期限約束。這是確定性測試，不冒稱真實校方曾等到第 450 秒。

`test/browser-observer.test.js` 驗證三種失敗階段、診斷不含回覆本文、失敗後 pending 清理；既有 SSE 切塊／斷線／空回答測試保留。`test/tool-execution.test.js` 使用真實 WorkspaceTools 驗證 CSV 拒絕標記與拒絕記憶，拒絕結果不含檔案資料。

最終 `npm test`：**412/412 通過**；`npm run build` 通過；`npm run browser:fixture` 的真實 Chrome localhost 測試通過（登入模式切換、串流、分段文件、取消、附件、對話清理、記憶／設定 UI，沒有校方請求）。修改後 `npm run sandbox:fixture` 通過，包括實際 `os.tmpdir()` 建檔／讀回、私有資料與憑證遮擋、禁止網路、允許專案寫入與真實 stdio MCP。另補平行 prepare 的單元測試，確認每個命令使用不同 scratch 且不改全域環境。

這些修改目前屬於未發行工作區變更，沒有覆蓋已安裝 0.6.20 或宣稱已發布新版。XML 控制格式、分段子任務接續、工具結果去重與寫後收據等較大改動列為後續改善，尚未宣稱修復。

## 可參考的 Agent 做法與下一步

1. **分清楚工具等待與模型等待。** 排隊、等待核准、OS 指令執行、網站接收、首字等待、串流中斷應各自計時與顯示，不能都標成「AI 沒回覆」。目前 shell 單次 60 秒與網頁導覽 45 秒也不受模型 600 秒設定控制。
2. **超時後先核對原請求，再決定重試。** 先保存部分內容與檢查點，核對專用頁面是否仍在生成／是否明確報錯；禁止因監看呼叫自身 timeout 而立即重送同一請求。對本地工具已完成的副作用，接續時必須沿用實際收據。
3. **把任務拆成可驗證的小步驟。** 輸出工具參數中整個大檔仍要等待完整且有效的結構化回覆才可執行；不應把半截 JSON 寫入工作區。可設計帶雜湊與序號的暫存分塊工具，完整校驗後原子套用，降低大檔一次生成風險。
4. **子任務要有可獨立查證的工作。** 空專案結構盤點的價值有限；更適合分派規格邊界／既有證據盤點，並與主 Agent 寫檔重疊。擴張子任務不能取代共用速率、預算、服務限制停止規則。
5. **完成需有具體收據。** 測試退出碼、實際測試數、產物與未完成範圍應在結語之前確認；預算停止、等待核准與服務錯誤都不算完成。
6. **不要用成功的 tail 代替測試退出碼。** 本次 Agent 曾用 `node --test 2>&1 | tail ...`，上游測試失敗仍會得到尾端命令的 0。庫存 Agent 有讀到錯誤並繼續調查，但 host 的一般 `ok:true` 並不能當成測試通過的證據。可加專門的 test runner 工具，保存原始退出碼與完整日誌，再另行顯示尾段；不得將截短顯示當成完整收據。

參考來源：

- [Anthropic sandbox-runtime 暫存環境實作](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-utils.ts)：本機實際 0.0.79 來源已讀取並以最小 probe 證實內層 TMPDIR 覆寫；不是只根據他人的問題回報推論。

- [OpenAI Agents 執行迴圈](https://developers.openai.com/api/docs/guides/agents/running-agents)：工具、交接、最終輸出的停止條件，以及以 session 保存狀態。這是 API harness 的架構參考，不能直接假設 NTPU 網站提供相同介面。
- [Codex SSE 實作](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs)：逐事件閒置監測、串流錯誤與未收到完成事件的區分。NTPU 現在只由實際文字延長閒置，不能將任意心跳當成內容進度而無限等待。
- [Cline 專案架構](https://github.com/cline/cline/blob/main/.clinerules/cline-overview.md)：工具執行、串流、重試與狀態由 harness 管理；需依 NTPU UI 及用量限制改寫，不能照搬所有自動重試。
- [codex-with-chatgpt 協定](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/535a07dbb7aee887924c53767d985c09d405319d/docs/protocol.md) 與 [等待策略](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/535a07dbb7aee887924c53767d985c09d405319d/skill/SKILL.md)：小型控制訊息與唯讀 MCP 資料層分離、明確 PLAN／EXECUTED／DONE／BLOCKED、持久檢查點；短間隔讀取 DOM 狀態，頁面仍生成就繼續等，不因一次 browser wait timeout 另開聊天室或重送。該專案是 ChatGPT 規劃＋Codex 執行橋接，並非可直接替換 NTPU 傳輸的 OpenAI 模型 API。

## 尚未涵蓋

本次不等同 Windows／macOS、Snap VS Code Extension Host、聊天面板排隊／引導、真人重新 SSO、每日校方尖峰或長時間耐久測試。有限場景沒有遇到的錯誤不能宣稱已不存在；診斷以實際觀察與可重現故障注入分開記載。
