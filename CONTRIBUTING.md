# 開發與問題回報

## 本地開發

1. 安裝 Node.js 20.9 以上、Chrome 與 VS Code。
2. 執行 `npm ci`、`npm run build`。
3. 在 VS Code 開啟本專案，按 F5 啟動 Extension Development Host。
4. 執行 `npm test` 確認主機權限、工具與 Agent 迴圈。
5. `npm run package` 在目前目標平台產生 VSIX；四平台產物由 CI 建立。

`npm run smoke` 與 `npm run mcp:smoke` 會使用真實第三方服務，受登入及用量限制影響。同一 Chrome profile 不可同時由擴充功能和 smoke 使用。

## Issue

提供版本、重現步驟、預期與實際結果。請先移除帳號、金鑰、私人檔案及對話。模型產出的文字不是工具成功的證據，請附對應工具結果。

## 設計原則

- 主機強制權限，模型與 skills 不能修改授權。
- 任務完成必須有實際工具結果；不把生成文字當成檔案或指令輸出。
- 網路與儲存資料的目的地在介面或文件說明。
- 精確修改與衝突檢查優先；停止不回溯已套用修改。
- 保持 VS Code 配色與鍵盤可操作性，工具詳情使用折疊進度列。
