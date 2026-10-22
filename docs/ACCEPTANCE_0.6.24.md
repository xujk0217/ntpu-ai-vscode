# 0.6.24 搜尋與製圖驗收

初次驗收：2026-10-20；真人補驗：2026-10-22（Asia/Taipei）。沿用並保留遠端 0.6.23 的附件選取、移除聊天匯出與 README 更新。

## 已完成的本機驗證

- `npm test`：430 項通過，0 失敗。新增工具資料驗證、PNG 實際渲染、唯讀限制、拒絕／取消、掃描失敗、越界、競爭建立檔案與不覆寫測試；真正主 Agent 循環確認圖檔保存證據可完成任務。
- `npm run build`：Webview 與可攜 Plugin bundle 成功。合併遠端修改後的真正 Chrome UI fixture 通過，三個搜尋／製圖範例只填入、不送出；沒有恢復已移除的聊天匯出。
- 完整 Google Chrome localhost fixture 通過：可控制的登入視窗、相同專用 Profile 背景交接、人工關窗／取消、串流、附件、分段文件、清理與介面。此為合成網站，不使用學校帳號。
- `npm run capabilities:fixture`：實際產生圖表／流程圖 PNG，在模擬原生 Tesseract 不存在時，以隨包英文 WASM 辨識；合成 Bearer 憑證被阻擋，損壞圖片清理 worker。worker 禁止 fetch，沒有下載語言模型。
- `npm run ocr:fixture`：既有原生 Tesseract／Poppler 的合成圖片、PDF 與秘密阻擋通過。沒有把原生解析或權限錯誤誤當成不存在的執行檔。
- 在隔離的真實 VS Code 1.141.0 Extension Host（Node v24.21.0）執行內建 WASM OCR 成功；測試使用新的 VS Code user-data／extensions 目錄，不讀取現有 Session、Memory 或專用登入資料。
- 真正 Exa 無金鑰搜尋 `site:developer.mozilla.org SVG viewBox` 成功，回傳包含 MDN 官方來源。已依服務實際 schema 提供必要 objective，初始化與呼叫都傳遞取消訊號。服務額度與可用性仍由 Exa 決定。
- Linux 原生 VSIX 已實際打包；解壓安裝包後直接執行製圖／真正 WASM OCR fixture 也通過，證明不只依賴開發目錄的模組。最後正式套件以 CI 與 Release 的 SHA256SUMS 為準。

## 10/20 真人試用的歷史阻礙

現有 VS Code 專用 Chrome Profile 正由其他 Chromium 實例持有，底層回報 ProcessSingleton；沒有刪除鎖或 Profile、沒有終止使用者瀏覽器。改用全新獨立測試 Profile，Playwright 確認可控制並真正開出學校登入視窗。等待人工登入 600 秒後仍未取得 authenticated 狀態，測試自行清理並關閉其持有的 context，未發送校方模型請求、未刪除校方對話。

10/20 當時沒有真人模型完成證據；10/22 已在同一獨立測試 Profile 人工完成登入後補驗，結果如下。

## 10/22 Linux 真人補驗：通過

測試程式為 **0.6.24／commit `2d29538aeb63265cc17b1b618e31b0d1285501e8`**。使用真正 NTPU 網站模型、正式主 Agent 工具迴圈與工作區工具；VS Code 工作區介面使用測試 adapter，不是從使用者的正式聊天側欄送出。模型沒有使用 fixture 回覆。

- 人工 SSO 完成後，Playwright 確認 `ready: true`／`authenticated`，再轉回背景連線並開始任務。
- 5 次模型請求均完整完成，個別約 3.9–10.7 秒；未觀察到 429、服務限制或逾時。此小型案例不代表長任務不會超時，600 秒閒置期限仍保留。
- 真正執行 `web_search` 與 `web_fetch`，讀取 [MDN viewBox 官方頁面](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/viewBox)。
- 真正執行 `create_chart`：Q1=12、Q2=18、Q3=15、Q4=24（萬元），[合成季度營收圖](images/live-chart-0.6.24.png) 為 1000×640 PNG、20,869 bytes，收據 `saved: true`。
- 真正執行 `create_diagram`：[需求確認 → 開發 → 測試 → 交付](images/live-workflow-0.6.24.png) 為 860×520 PNG、13,569 bytes，收據 `saved: true`。兩圖均經本機掃描，並已實際開圖檢查標籤、數值與連線。
- 核准僅允許這次的公開搜尋／讀取及兩個製圖工具；未使用 Shell、未安裝外部服務，沒有另外的影像服務 API key。任務由真實工具證據結束，沒有持續重複結語。
- 保存檢查點後清理擴充功能自己建立的 5 個校方測試對話，成功 5、失敗 0；未刪除既有校方對話、本機聊天或 Project Memory。
- 關閉本次 context 後，在 **兩次不同 PID 的真實 VS Code 1.141.0 測試 Extension Host（Node v24.21.0）** 中重開同一專用 Profile，皆恢復 `ready: true`／`authenticated` 的背景連線。使用隔離的 VS Code user-data／extensions 目錄，沒有重啟或接管使用者原本的工作視窗，也沒有匯出認證資料。

不含憑證、模型本文或登入頁內容的 [驗收統計](evidence/ntpu-capabilities-2026-10-22.json) 一併保存。本次證據屬 Linux／0.6.24 的限定案例，沒有因此宣稱新版 macOS 原生桌面、Windows 真人 SSO 或使用者正式側欄端到端皆已通過。原 10/20 VSIX 與 tag 保持原樣，這次僅補上後續驗收文件。

## 跨平台發行門檻

Windows x64、macOS Intel／Apple Silicon、Linux x64 分別執行 Node 20／22 CI，新增隨包製圖與離線 OCR fixture；既有回歸、build、localhost 登入交接與受控 Computer Use fixture 保留。Linux／macOS Node 22 另執行原生沙箱／OCR。各 OS 原生打包，發布工作流核對精確 CI commit、所有來源、版本、平台、離線 WASM／語言資源與 checksum 才上架。

實際 CI／發布連結與四個 VSIX、Plugin、SHA256SUMS 位於 [v0.6.24 Release](https://github.com/xujk0217/ntpu-ai-vscode/releases/tag/v0.6.24)。Windows／macOS 真人桌面與 SSO、Windows Shell／stdio、非 Linux 原生桌面等既有缺口仍見[平台對照](PLATFORM_PARITY.md)，不能因打包成功而視為完成。

照片型影像生成模型與 PDF Poppler 未隨包附帶。內建能力與依賴界線見[搜尋與製圖說明](BUNDLED_CAPABILITIES.md)。
