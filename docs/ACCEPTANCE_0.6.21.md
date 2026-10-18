# 0.6.21 發行驗收紀錄

## 修改內容

- `parseReply` 僅從敘述中復原唯一、完整的 JSON envelope；引號／程式碼圍住的範例、多個 envelope、XML invoke 與不完整 JSON 不會執行。無效控制格式會保留為內部診斷並進行有限修復。
- Agent 對同一檔案、文字未變且已完整覆蓋的行區間只回傳短收據，避免把相同檔案內容反覆塞進上下文；讀取不同或已修改內容仍照常回傳。
- Agent 已取得後續安全查證、並確認 run_command 因 OS 沙箱相依或命令不存在而失敗時，顯示被遮蔽且限長的具體錯誤、建議下一步、保留檢查點並以 `completed:false` 停止，不做多輪無進展查閱。
- 以上均在共用 Agent 程式，會進入 Linux、Windows 與 macOS 套件。Windows Shell／stdio MCP 與 Linux 以外的原生桌面控制保持平台原有限制。

## Linux 本機驗證

- `npm test`：416 項通過，0 失敗。此測試需可開 loopback MCP fixture；在受限 shell 首次被 `listen EPERM` 阻擋，改在使用者權限的測試環境執行後全部通過。
- `npm run build`：前端與可攜 Plugin bundle 建置成功。
- `npm run sandbox:fixture`：Linux bubblewrap 通過；確認唯讀／拒絕秘密路徑／工作區寫入／封鎖網路／stdio MCP。
- `npm run browser:fixture`：真正本機 Chrome 與 localhost mock 通過；確認登入視窗、持久 Cookie handoff、關窗、背景串流、長文分段、上傳、任務清理及 UI。未呼叫 NTPU AI。
- `npm run computer:fixture`：獨立工作瀏覽器 fixture 通過；核准、Unicode 輸入、操作後觀察均成功，學校請求數為 0。
- `npm run package -- --target linux-x64`：於 Linux 原生打包成功；VSIX manifest 為 `linux-x64`、版本 `0.6.21`。SHA-256：`2db668825b3996b8544abb01ed8bf76acecd5b92b01f9269bcf8d9e7715da1a7`。Plugin ZIP SHA-256：`816e93ef1aaa0bdfb1f7f8c8ebc682f614d390d3e1b28c30830c3e8f1c2e26cf`。
- `git diff --check`：通過。

## 平台差異與未驗收項目

本機只有 Linux，不能聲稱 Windows／macOS 實機或真人 SSO 驗收通過。發行必須等待 main push CI 的 Windows Server 2022、macOS Intel／Apple Silicon、Linux 各 Node 20／22 工作全數通過，再由 release workflow 檢查並發布四種原生 VSIX 與 Plugin ZIP。Windows OS sandbox-runtime 是 Alpha，本擴充未啟用；Windows Shell／stdio MCP 仍拒絕執行。Windows 與 macOS 真人登入恢復和原生 Computer Use 不在本次 CI fixture 範圍。

Linux 三個真實 NTPU 模型專案與兩個 VS Code UI 專案的結果及停止點見[模型請求評估](AGENT_EVALUATION_2026-10-18.md)與[VS Code UI 評估](AGENT_UI_EVALUATION_2026-10-18.md)。實測未發現 240 秒提前超時；主要可重現問題是共用控制格式錯誤／重讀導致不完整與延長任務，不能據此宣稱 Windows 的歷史個案已實機重現。
