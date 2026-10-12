# 本地 Agent 範例

此資料夾保留實際 NTPU AI Agent 任務產出，供開啟成獨立 VS Code 工作區。

- `add.js`：先前由 Agent 建立並改為可變參數加總。
- `stats.js`：平均值函式，空陣列回傳 null；CommonJS 匯出。
- `stats.test.js`：Node 內建測試，驗證平均值、負數與空陣列。
- `vision-fixture.png`：圖片分析測試圖，文字 NTPU VISION 42、紅色正方形與綠色三角形。
- `agent-visual.png`：由模型繪製 SVG，再經本地工具產出的白底藍色圓形 PNG。

執行測試：

```sh
node --test stats.test.js
```

範例任務：

> 查看專案，新增一個統計函式與測試，執行測試，有錯誤就修正到通過。使用任務清單管理進度，最後回報真實結果。
