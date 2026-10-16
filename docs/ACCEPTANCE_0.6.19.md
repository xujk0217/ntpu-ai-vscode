# 0.6.19 驗證補記

延續 [0.6.18 完整功能紀錄](ACCEPTANCE_0.6.18.md)。2026-10-16，本機 Ubuntu 24.04 Linux x64，非 root，Wayland 桌面中的 XWayland。

- 388／388 回歸測試通過；新增 XTerm、rxvt、Konsole、st、Opera、qutebrowser、Code Insiders 等視窗不可選取的回歸。前端與 Python 輸入後端共用 `src/computer/window-policy.json`，未放寬核准或沙箱。
- 再次執行真實 Chromium localhost fixture：Unicode fill、click、讀回驗證、登入與 iframe 擷取拒絕通過。
- 再次執行自建 GTK X11 視窗 fixture：選定視窗擷取、鍵鼠控制、重新觀察及實際收據通過，未控制私人視窗。
- 另以真實工作瀏覽器截圖接 Tesseract 掃描：乾淨畫面通過，合成 Authorization Bearer 圖片遭拒絕；零校方請求。使用獨立驗證工具路徑，本機系統尚未安裝 OCR／socat，`sudo -n true` 確認需要人工密碼；未更改使用者設定或取得密碼。
- 四平台原生 VSIX 及可攜 Plugin 的發布仍必須通過當版八組 CI；公開資產、原始碼、版本及 SHA-256 由發布 workflow 核對，實際結果見 v0.6.19 Release／Actions。

真人校方視覺分析、SSO 與外部 Agent 端到端驗收仍待使用者操作；原生 Wayland／Windows／macOS 桌面後端未支援。版本修正不變更本機聊天、Checkpoint、Project Memory 或校方專用登入 Profile。
