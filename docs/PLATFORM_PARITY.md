# 目前平台能力與待辦

基線：**0.6.24**；更新日期：2026-10-20。Linux 有較多真實桌面調查證據，但三平台使用同一份 Agent、聊天、歷史、Checkpoint、Project Memory、核准、工具探索、唯讀子任務、長文、佇列／引導與逾時監測程式。原生打包不代表所有 OS 功能完全相同，CI 通過也不代表真人學校登入或 Windows 歷史卡頓已通過驗收。

| 能力 | Linux x64 | Windows x64 | macOS arm64／x64 |
| --- | --- | --- | --- |
| Agent／聊天／記憶／核准／子任務／長文／佇列與引導 | 共用實作 | 共用實作 | 共用實作 |
| 模型等待與停止恢復 | 共用閒置期限、串流停頓診斷與停止清理 | 同左 | 同左 |
| 專用模型登入瀏覽器、背景交接 | Chromium 系瀏覽器 | Edge／Chromium | Chrome／Chromium |
| Shell／stdio MCP 隔離 | bubblewrap，需 Node 22.12+、bubblewrap、socat、ripgrep | **尚未接入，拒絕執行**，不回退無隔離 shell（[#1](https://github.com/xujk0217/ntpu-ai-vscode/issues/1)） | Seatbelt，需 Node 22.12+ |
| 受控 Computer Use 工作瀏覽器 | 支援 | 支援 | 支援 |
| 原生桌面 Computer Use | X11／XWayland；原生 Wayland 待辦（[#4](https://github.com/xujk0217/ntpu-ai-vscode/issues/4)） | 待辦（[#2](https://github.com/xujk0217/ntpu-ai-vscode/issues/2)） | 待辦（[#3](https://github.com/xujk0217/ntpu-ai-vscode/issues/3)） |
| 內建搜尋／本機圖表、流程圖 | 支援 | 支援 | 支援 |
| 預設英文圖片 OCR | 原生 Tesseract／隨包 WASM 後備 | 同左；不再要求另裝 Tesseract | 同左 |
| PDF 文字解析／轉頁 | 仍需 Poppler | 仍需 Poppler | 仍需 Poppler |
| 目前版本 VS Code／真人 SSO 實機驗收 | 有歷史桌面專案與 SSO 證據；本次 0.6.24 的真人驗收另列紀錄 | 待辦（[#5](https://github.com/xujk0217/ntpu-ai-vscode/issues/5)） | 待辦（[#6](https://github.com/xujk0217/ntpu-ai-vscode/issues/6)） |
| ARM64 原生 VSIX | 待辦（[#8](https://github.com/xujk0217/ntpu-ai-vscode/issues/8)） | 待辦（[#7](https://github.com/xujk0217/ntpu-ai-vscode/issues/7)） | 已提供 |
| 已發行／預定原生套件目標 | linux-x64 | win32-x64 | darwin-x64、darwin-arm64 |

完整待辦總覽：[跨平台追蹤 Issue #9](https://github.com/xujk0217/ntpu-ai-vscode/issues/9)。每項子 Issue 有獨立的驗收條件。

## 本次共用修正

新增 create_chart、create_diagram、內建能力清單與試用範例，修正 Exa 真實搜尋必要參數及初始化取消，隨包離線英文 OCR。這些共用功能進入四種原生 VSIX；既有聊天、佇列、Memory、權限及平台沙箱差異保留。詳見[內建能力](BUNDLED_CAPABILITIES.md)。

## 驗證的界線

四平台原生 CI 包含 Node 20／22 回歸、build、localhost 登入視窗／背景交接、受控工作瀏覽器 fixture；Linux／macOS Node 22 額外跑原生 OS 沙箱與 OCR fixture。四種平台 Node 20／22 均另外執行隨包製圖／離線 OCR fixture，含真正 WASM 辨識和合成憑證阻擋。Windows 的 OS 沙箱及原生 PDF OCR 實機驗收仍由 #1、#5 追蹤。各 OS 的 Node 22 job 原生打包 sharp，發布工作流比對完整來源、版本、平台、資產與 checksum。

本機目前只有 Linux。未建立可用 Windows VM，亦未取得 macOS 桌面，因此本次沒有 Windows／macOS 真人校方 SSO、新版實機 Agent 或歷史 Windows 卡頓個案的完成證據。這些是驗收缺口，不表示共用功能全未實作；後續須由對應平台的實際 Extension Host 取得證據。

歷史 Linux 真實網站／桌面結果見 [0.6.21 平台紀錄](PLATFORM_PARITY_0.6.21.md)、[Agent 評估](AGENT_EVALUATION_2026-10-18.md)與 [UI 評估](AGENT_UI_EVALUATION_2026-10-18.md)。目前版本驗證見 [0.6.24 驗收](ACCEPTANCE_0.6.24.md)。

## 共用限制

受控工作瀏覽器仍限定核准的單一 origin；原生桌面控制仍需逐次核准和操作後觀察，不能繞過秘密／檔案／Shell 邊界。Remote SSH、WSL、Dev Container 不會被當作已連到使用者本機桌面。詳見 [Plugin／Computer Use 範圍](PLUGIN_COMPUTER_USE.md)。
