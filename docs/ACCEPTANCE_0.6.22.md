# 0.6.22 發行驗收紀錄

日期：2026-10-19（Asia/Taipei）。

## 共用程式修正

- 排隊中的留言只在輸入框上方的獨立區域顯示，依 FIFO 往下排列、保留完整文字；每筆有引導與移除控制，等待核准時也不隱藏佇列。
- 初始化 queued 標記時同時考量執行中任務、既有佇列及進行中的佇列交易，避免訊息先閃現於對話才被移回佇列。
- 真正執行／接收引導時才移至對話尾端，保留訊息 ID、原排隊時間與實際進入對話時間。模型上下文、磁碟紀錄、重新載入、載入歷史與匯出使用實際順序。
- 命名、Computer Use、子任務與排程清理的非預期錯誤各自處理，避免提前跳出清理而留下 busy/controller。取消後保留已套用的修改與佇列，手動繼續會按 FIFO 執行，沒有自動重新啟動已停止的任務。
- 平台功能沒有僅在 Linux 更新的分支；同一份程式進入四種原生 VSIX。平台缺口列於[目前對照](PLATFORM_PARITY.md)與 [GitHub #9](https://github.com/xujk0217/ntpu-ai-vscode/issues/9)。

## Linux 本機證據

- `npm test`：418 項通過，0 失敗；包含落盤對話順序、未來佇列不進入當前 prompt、引導不重複執行、取消後新增／恢復 FIFO、副任務回呼拒絕後主輸入復位。
- `npm run build`：UI 與可攜 Plugin bundle 成功。
- `npm run browser:fixture`：完整 Google Chrome localhost fixture 通過，涵蓋登入視窗、同一專用 Profile 背景交接、手動關窗／取消、串流、分段完整文件、上傳、任務清理與 UI。
- 最終聚焦 Chromium UI fixture 通過；明確啟用 Chromium sandbox，驗證固定佇列、多筆順序、等待核准仍可引導、實際進入對話的順序、歷史重繪，以及未在最近 50 則頁面中的舊排隊訊息 patch。
- `npm run package -- --target linux-x64`：Linux 原生打包成功，版本 0.6.22。正式交付以 CI 原生資產及 Release SHA256SUMS 為準。
- `git diff --check`：通過。

本次測試使用合成對話、附件與 localhost 網站，不發送 NTPU AI 真實模型請求、不使用學校帳號。先前真人 Linux 評測仍是歷史證據，未以本次 fixture 宣稱新的真人 SSO 已通過。

## 發行門檻與證據位置

推送 main 後，CI 必須在 Windows x64、macOS Intel／Apple Silicon、Linux x64 各以 Node 20／22 跑完整回歸、build、localhost 登入交接與受控工作瀏覽器；Linux／macOS Node 22 另跑 sandbox／OCR fixture。各 OS 的 Node 22 工作原生打包 VSIX，Linux 工作另打包可攜 Plugin。

發布工作流只接受同一個 main push、成功完成的 CI 與指向其精確 commit 的草稿 Release；檢查四種原生平台、版本、完整來源、Plugin、資產內容與 SHA-256 後上架。實際 CI／發布工作流連結與正式 `SHA256SUMS.txt` 位於 [v0.6.22 Release](https://github.com/xujk0217/ntpu-ai-vscode/releases/tag/v0.6.22)。以 Release 資產及其 checksum 作為可安裝套件的正式證據；本機重建的 ZIP 時戳／依賴打包可能造成不同檔案雜湊。

Windows Shell／stdio MCP、Windows／macOS 原生桌面、原生 Wayland、Windows／Linux ARM64 與新版真人驗收缺口均未因發布而宣稱完成。詳見 [#1～#8 與總追蹤 #9](https://github.com/xujk0217/ntpu-ai-vscode/issues/9)。
