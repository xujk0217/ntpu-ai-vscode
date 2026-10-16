# 0.6.18 本機驗證紀錄

日期：2026-10-16。Linux x64／Ubuntu 24.04，非 root 桌面；Wayland 工作階段，透過 DISPLAY 使用 XWayland。模型學校登入 Profile、既有聊天、Session／Checkpoint／Project Memory 不需遷移，未匯出校方憑證。

- `npm test`：387／387 通過。新增本機 MCP broker 的原文長文分頁、無權限／Origin／描述檔拒絕、取消保存、真正打包 stdio 握手與五工具呼叫、外部分析核准／429／無工具與記憶隔離、重複啟用及匯出、保存失敗；另測 computer 權限／取消／網路限制、一次性觀察、未驗證結語攔截及最低 16,000 字元預算。
- `npm run build`、Linux 原生 VSIX 與可攜 Plugin ZIP 打包成功，Linux VSIX 已用 VS Code CLI 安裝。可攜包不含連線檔、機器路徑或校方登入資料。
- `npm run computer:fixture`：本機真實 Google Chrome、Chromium sandbox 啟用、獨立 Profile、正常視窗。Playwright 觀察合成頁面，填入中文與 emoji、點擊並讀回原文；共三次截圖，登入欄位／iframe 擷取拒絕，舊 observation 拒絕；零校方請求。
- `npm run desktop:fixture`：只建立並選擇自己的合成 GTK X11 視窗。擷取 480×240 視窗、點擊、鍵盤輸入、重新觀察，以 fixture 收據驗證完整字串及 click。此欄位關閉輸入法以測試鍵盤後端；實際桌面打字仍受使用者 IME 影響。此測試注入合成影像分析回呼，**不代表校方視覺模型已驗收**。
- `npm run browser:fixture`：真實 Chrome 操作 localhost 模擬網站，登入視窗／session-cookie 背景交接、手動關閉／取消、串流、分段長文、任務重用、附件、專用 Profile 持久化、記憶與設定 UI 通過；零校方請求。
- `sandbox:fixture`：Linux bubblewrap 實際檔案與網路隔離、工作區可寫、受保護與外部檔案讀取阻擋、stdio MCP 通過。
- `ocr:fixture`：實際 Tesseract／Poppler 辨識，乾淨圖片／PDF 通過、合成憑證阻擋，零校方上傳。

本機系統 PATH 缺少 Tesseract／socat；後兩項使用先前下載到獨立驗證目錄的工具及明確 LD_LIBRARY_PATH／TESSDATA_PREFIX 執行，未冒充系統已安裝。實際截圖功能仍需安裝 OCR 依賴或設定持久執行檔路徑。沒有為了驗證更改使用者 VS Code 設定或重新載入中的視窗。

第一輪跨平台 CI 發現測試清理順序在 Windows 會先刪除仍被 MCP 子程序當作 cwd 的資料夾，回報 EBUSY；已改成同一清理 hook 先關閉子程序再清除 fixture，沒有跳過 Windows stdio 測試。

跨平台發布要求 CI 的四個原生平台 × Node 20／22 全部通過，各組另跑受控工作瀏覽器 localhost 驗證；只有 Node 22 組原生打包。原生桌面後端不在 Windows／macOS 執行，也未宣稱支援原生 Wayland。公開 Release 是否成功及實際 CI 結果以該標籤與 Actions 紀錄為準。

尚待真人：重新載入已安裝的 VS Code，匯出 Plugin，從支援 MCP 的外部 Agent 提交非敏感提問並在 VS Code 核准；以及核准截圖後的真實校方視覺分析。這次未自動操作真人 SSO，未發出校方模型請求，也未將 Plugin 上架 OpenAI 公開目錄。
