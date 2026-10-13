# 更新紀錄

## 0.5.0

- 側欄可互動小瀏覽器，共用專用登入 Profile，提供背景模式與原生視窗。
- 設定分成連線、工具、安全；進階路徑與 MCP 位址預設收起。
- Shell／stdio MCP 強制 OS 隔離，禁止網路；Windows 待驗收暫停執行。
- 圖片逐格、PDF 全頁及嵌入文字本機檢查，秘密或解析失敗即拒絕上傳。
- 原生沙箱、OCR 驗收工具與多平台 CI；明列依賴、已知弱點與未驗證範圍。

## 0.4.3

- 關閉瀏覽器顯示「未連線」，重新開啟後確認登入；只有網站要求登入或使用者明確登出才顯示「未登入」。
- 加入官方 NTPU AI4X 唯讀 MCP preset、官方校務 Assistant 入口與研究 skill。
- macOS 真正 NTPU AI 回覆及同 Profile 重開登入保存已實測；OS 沙箱與附件 OCR 仍在開發，未宣稱完成。

## 0.4.2

- 聊天紀錄列表加入每筆 ⋯ 選單：重新命名、完整 Markdown 匯出、封存／恢復與確認刪除。
- 勾選與搜尋範圍全選、批次封存／恢復／刪除，刪除目前聊天後安全切換。
- 保留搜尋輸入焦點，執行中停用管理；防止並行操作與錯誤批次選取。
- 補上聊天管理、指定聊天匯出、取消刪除、部分刪除失敗及列表互動驗證。

## 0.4.1

- 補強結構化 Cookie 集合、Cookie／Set-Cookie 標頭遮蔽，避免 MCP 結果、模型脈絡或本機保存帶入登入資料。
- 增加假 Cookie 回歸測試；其餘功能與升級方式同 0.4.0。

## 0.4.0

- Local-first Project／Session／Task 記憶：完整歷史、分頁、原子保存、舊資料備份遷移、跨帳號接續、可恢復 checkpoint。
- 相關記憶檢索與上下文字元預算；只根據工具證據更新，不增加背景模型請求。
- Session 搜尋、封存、刪除、完整匯出、記憶備份還原與 Project Memory／Privacy 設定。
- 共用 Sensitive Data Guard：Protected／Review／Normal、秘密遮蔽、模型出口與保存檢查；完整存取不能繞過。
- Browser Manager：Auto／Chrome／Edge／Chromium／Custom，依瀏覽器隔離 profile，跨平台偵測、啟動確認與設定。
- Windows x64、macOS arm64／x64、Linux x64 原生 VSIX；四平台 × Node 20／22 CI。

升級會先備份再遷移現存 Session，原版已截斷的歷史無法復原。新的隔離瀏覽器 profile 首次需要人工登入；不複製 Cookie。安裝後執行 **Developer: Reload Window**。

仍為實驗版；完整驗證範圍、Shell／MCP 沙箱與圖片辨識限制見 [重構交付與驗收](docs/REFACTOR_REPORT.md)。
