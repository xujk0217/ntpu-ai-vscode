# 官方服務、真實驗證、OS 隔離與附件 OCR

## 本輪要求與驗收界線

- 真正呼叫 NTPU AI，在 Mac 人工完成 SSO／驗證碼後驗證 Agent 任務與登入保存。
- 使用者選擇：先測 Mac，其他平台準備驗收流程；Windows／Linux 真實學校 SSO 不冒充已驗證。
- Shell 與 stdio MCP 增加真正 OS 隔離，限制可見檔案、環境、網路及子程序；啟動失敗阻止執行。
- 圖片／PDF 上傳前本機 OCR、秘密檢查，偵測到秘密或無法完成檢查時阻止原附件外傳。
- 研究並整合官方 https://ai4x.mcp.ntpu.ai/mcp；保留來源資料。
- 官方校務問答 https://aia.ntpu.ai/ 採官方入口與路由指引，不複製其問答系統，不使用未公開 API。

## 查證（2026-10-13）

AI4X 官方 [文件](https://ai4x.mcp.ntpu.ai/docs) 說明公開、唯讀、不需金鑰及 Streamable HTTP。已以 MCP SDK 完成 initialize／tools/list，取得 11 個工具；研究專家工具提供 evidence，資料結果附 provenance。文件 hybrid 搜尋尚未支援，不得假裝使用語意搜尋。

Assistant [首頁](https://aia.ntpu.ai/) 目前列出 21 個單位；回答以已匯入資料為限。研究中未取得可對外整合的公開問答 API 規格。

## 分段

- [ ] 官方服務 preset、UI、skill、來源保存與真正 MCP 查詢。
- [ ] OS sandbox 主機執行邊界、stdio MCP、設定與隔離測試。
- [ ] 本機圖片／PDF OCR、阻擋流程、設定與假秘密測試。
- [ ] Mac 真實 SSO／NTPU Agent、其他平台驗收指南。
- [ ] CI、套件、README、測試紀錄與分段提交。

OCR 與 OS sandbox 是可驗證的防護機制，不能宣稱辨識所有秘密或防止所有 OS／容器漏洞。官方 MCP 的公開資料仍屬外部內容，不具有修改主機安全政策的權限。
