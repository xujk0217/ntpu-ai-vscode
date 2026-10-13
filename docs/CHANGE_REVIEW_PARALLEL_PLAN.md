# 變更檢視與並行 Agent（2026-10-14）

## 使用者需求

- 已套用的檔案變更可明確保留，或撤回一個檔案／一段變更。
- 真實測試 NTPU AI 的兩個對話能否同時串流，據此設計 Agent 多工。
- 參考 oh-my-openagent 主 Agent 分工、唯讀探索／研究／審查及並行數限制。
- 確認 NTPU AI4X MCP 與官方校務 Assistant 的整合及應用。

## 實作與驗收

1. 變更檢視：同一任務同一檔案合併為檔案 diff；保留與撤回檔案／hunk。回復前比對目前檔案雜湊，拒絕覆蓋後續手動修改。新增檔案撤回使用資源回收桶；圖片只支援整個檔案。
2. 多工基礎：同一專用 BrowserContext 的不同 Page，各自維持對話、觀察器與取消操作；不複製 Profile 或匯出 Cookie。測試使用兩個有限的小型請求，不重試 429 或繞過登入。
3. 並行本機讀取：一個模型回合可請求一組獨立唯讀工具，保持安全檢查與核准。修改／Shell 由主 Agent 依序執行。
4. 委派：主 Agent 規劃；探索、研究、審查 worker 唯讀。每個 worker 有獨立對話與工具紀錄，限制數量與模型回合。未確認學校端並行能力時，模型請求採序列方式。
5. 介面：可展開的 worker 進度、結果與變更 hunk；設定可測試／控制並行。
6. 官方服務：AI4X 已是內建 MCP，校務 Assistant 已有官方網站入口；以實際工具 catalog 與公開資料確認應用。

## 參考

- [oh-my-openagent orchestration overview](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/overview.md)
- [oh-my-openagent concurrency manager](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/features/background-agent/concurrency.ts)

本專案自行實作，參考任務分工與限流概念，未複製該專案原始碼。

## 狀態

- [x] 變更 UI、單一檔案／hunk 撤回及衝突測試。
- [x] Browser 多對話隔離與 mock 同時串流。
- [x] 真實 NTPU AI 同時串流探測。
- [x] 本機唯讀工具批次與 worker orchestration。
- [x] AI4X 實際公開查詢及使用說明。
- [x] README、macOS 套件與本機安裝；多平台 CI 設定完成。
- [ ] 發布前確認多平台 CI 通過及四平台 VSIX 產物。
