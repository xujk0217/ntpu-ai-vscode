# 0.6.12 驗收範圍

## 本機 Linux

環境為 Ubuntu 24.04 x64、Node 24.21.0，使用系統 Google Chrome 與暫存的獨立測試 Profile。

- `npm test`：完整單元與整合回歸，包含真正 AgentApp／MemoryStore 存盤後才接續、重啟恢復、完整匯出、既有聊天與 Project Memory 保留、主子 Agent 同時工作與結果收集、核准與取消，以及原有瀏覽器／安全測試。
- `npm run build`：實際建置側欄腳本。
- `npm run browser:fixture`：真正 Playwright／Chromium 控制 localhost 網站，驗證圖形登入視窗與背景交接、登入持續性、附件、串流、取消、對話清理，以及超過一萬字的分段文件原樣回傳和 UI 操作。設定頁與原文檢視在 340px 側欄驗證。
- `npm run sandbox:fixture`：真正 Linux bubblewrap 讀寫與網路隔離、敏感檔案封鎖及 stdio MCP。這台主機缺少 socat，測試時將 Ubuntu 原生套件解到 `/tmp`，加入測試程序 PATH；沒有以 sudo 啟動 VS Code，也沒有關閉沙箱。
- `npm run ocr:fixture`：真正 Tesseract 5.3.4／Poppler 的圖片與 PDF 檢查；乾淨文件通過，合成憑證被攔截。Tesseract 及其相依套件同樣只解到 `/tmp` 供測試使用，未上傳到學校服務。
- `npm run package -- --target linux-x64`：在 Linux 原生驗證 sharp 並打包。發行前另檢查 VSIX 版本、來源檔、Schema 與原生二進位架構。

## 四平台發行

[CI](https://github.com/xujk0217/ntpu-ai-vscode/actions/workflows/ci.yml) 分別在 Linux x64、Windows x64、macOS arm64／x64 執行 Node 20／22 回歸、建置與真正 localhost 瀏覽器 fixture。Node 22 各自打包對應平台的 VSIX；Linux 與 macOS Node 22 額外執行原生沙箱與 OCR 驗收。

[發行工作流程](https://github.com/xujk0217/ntpu-ai-vscode/actions/workflows/publish-release.yml) 只接受 main 的成功 CI，檢查四個原生套件的版本、來源內容、架構與禁止收錄資料，再透過 GitHub CLI 上傳並核對 SHA256。該版本的確切結果與套件請見 [v0.6.12 Release](https://github.com/xujk0217/ntpu-ai-vscode/releases/tag/v0.6.12)。

## 尚未涵蓋的真人操作

本次新增功能的驗收使用 localhost 與模型 stub；沒有將它冒充為校方模型對新分工／分段協定的真人驗收，也沒有為了測試重登入、讀取日常瀏覽器 Profile 或記錄憑證。真實 NTPU 模型仍須配合輸出格式；程式不能復原網站未產生的文字。校方 SSO、429 及用量限制維持原規則。

0.6.11 曾在此 Linux 桌面確認恢復有效登入、真人確認正常視窗、關窗後背景請求及重啟登入恢復，細節見 [Linux 登入驗收](LINUX_LOGIN_VALIDATION.md)。這份證據不等於 Windows／macOS 真人 SSO 通過；Windows 原生 Shell／MCP 沙箱仍待對應環境人工驗收。
