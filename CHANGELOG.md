# 更新紀錄

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
