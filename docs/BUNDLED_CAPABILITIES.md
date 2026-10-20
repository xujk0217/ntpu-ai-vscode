# 內建搜尋與製圖

0.6.24 將這些能力直接放入 VSIX。安裝對應平台的套件、重新載入、完成原有 NTPU 登入後，直接在 Build Agent 提問即可；不需要安裝 OpenClaw、另外部署橋接服務或使用 Shell 安裝繪圖程式。設定 → 工具有可填入聊天的三個範例，按鈕只填入、不自動送出。

| 能力 | 內建工具 | 額外需求 |
| --- | --- | --- |
| 公開網頁搜尋、引用來源 | `web_search`／`web_fetch` | 地球開關啟用、網路；Exa 首次自動連線，不需使用者 API key，仍受供應商額度／可用性限制 |
| 資料長條、折線、圓餅圖 | `create_chart` | 選定工作區、Build 與檔案修改權限 |
| 有向流程圖 | `create_diagram` | 同上 |
| 自訂向量插畫、版面 | `create_visual` | 模型提供安全 SVG；本機轉為 PNG |
| 照片型 AI 生圖、既有圖片編輯 | 未隨包附帶模型 | 另行設定實際影像服務／額度；不能把向量繪製宣稱為已接通影像模型 |

## 試用

- 「請查詢 MDN 的 SVG viewBox 官方說明，附來源連結，勿安裝額外工具。」
- 「請用 create_chart 把合成季度營收 Q1=12、Q2=18、Q3=15、Q4=24（萬元）畫成長條圖，存成 quarter-chart.png。」
- 「請用 create_diagram 繪製需求確認→開發→測試→交付的流程圖，存成 workflow.png。」

搜尋是外部服務；實際查詢文字會傳至 Exa。繪圖與 OCR 在本機執行，不會為繪製圖片呼叫外部影像模型。Agent 的原始任務、工具參數／結果仍依原有流程傳給校方文字模型；本機製圖不代表整個 Agent 可離線運作。來源網頁與 MCP 結果都視為資料，不授予權限。遇 429／登入失效立即停止，不繞過服務限制。

圖表接受 1–12 個標籤、1–4 組等長有限數值；圓餅只接受一組非負且總和大於零的資料。流程圖接受最多 10 節點／20 連線，可由上到下或由左到右排列。畫布最多 2048×2048；過小而無法容納標籤時要求增大尺寸。模型須標明合成資料，真實資料需附來源；不默默補值或丟棄數字。

工具先實際轉成 PNG 並做既有圖片安全檢查，核准後才在工作區保存。唯讀 Agent 無法存圖；拒絕、取消、路徑越界與同名檔案都不會覆寫。`saved`、路徑與實際輸出收據進入 Checkpoint，沒有實際存檔不宣稱已完成。

## 離線 OCR 與依賴界線

VSIX 帶有 Tesseract.js、WASM 與英文語言資料。預設原生 Tesseract 找不到（ENOENT）且語言為預設 `eng` 時，改用內建辨識；worker 禁止網路取得模型，不寫入 OCR 本文或語言快取。每次辨識有 45 秒界線，失敗／逾時終止持有的 worker，圖片仍採失敗即阻擋。

已安裝的原生 Tesseract 繼續沿用。明確設定的執行檔、非英文語言、原生權限或解析失敗會回報錯誤，不靜默改用另一套設定。英文 OCR 針對憑證格式，並不保證辨識所有語言／秘密；原有文字遮蔽、附件確認、工作區與核准限制不變。

PDF 頁面解析及轉圖仍需要原生 Poppler；本次沒有把它或照片型生成模型包入 VSIX。各平台既有 Shell／桌面 Computer Use 差異見[平台對照](PLATFORM_PARITY.md)。

## 驗證方式

`npm run capabilities:fixture` 在沒有原生 OCR 的模擬環境中，實際產生 PNG、以內建 WASM 掃描、阻擋合成 Bearer 憑證，並測試損壞圖片能清理背景 worker；它不存取學校帳號、不做外部搜尋。此 fixture 在四種原生 CI 的 Node 20／22 執行。

本機另外做過真實 Exa 搜尋；主 Agent 工具循環以可重現模型 fixture 驗證保存證據。真人 NTPU 登入及模型選用工具另列驗收狀態，不以 localhost 或模型 fixture 取代。詳見[0.6.24 驗收](ACCEPTANCE_0.6.24.md)。

服務說明：[Exa 官方 MCP](https://exa.ai/mcp)、[Tesseract.js 本機資源設定](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)。
