# macOS 能力補齊與驗收：0.6.25

日期：2026-10-20。對照 GitHub Issues #1–#9、最新版 0.6.24 與目前來源。本輪新增 0.6.25 的 macOS 單一原生視窗後端，並保留上版共用能力。

## 逐項核對

| Issue | 這台 Mac 的處理結果 |
| --- | --- |
| #1 Windows OS 沙箱 | 需要 Windows 隔離後端與主機驗收；未改動 win32 拒絕執行邊界。 |
| #2 Windows 原生桌面 | 需要 Windows 視窗／輸入後端；未用 Mac 結果代替。 |
| #3 macOS 原生桌面 | 已新增 ScreenCaptureKit／AX 單一視窗後端及原生打包；本機 arm64 合成 AppKit 實測通過。Intel 桌面與不同應用程式、OS 的額外驗收仍保留。 |
| #4 Linux 原生 Wayland | 需要 Wayland Portal／桌面授權環境；未改動既有 X11 後端。 |
| #5 Windows 實機驗收 | 需 Windows 主機與人工 SSO；未完成。 |
| #6 macOS 實機驗收 | Apple Silicon 的 native helper、OS 隔離／MCP、OCR、瀏覽器合成流程、本機 VSIX 已驗證；本次真人 SSO、重啟後學校真實請求、Intel 實機及 VS Code 完整端到端仍待驗收。 |
| #7／#8 Windows／Linux ARM64 | 需相符原生 runner／主機，未重標 x64 二進位檔。 |
| #9 跨平台追蹤 | 更新本機平台對照與範圍文件；沒有把子項部分進展標為全部完成。 |

## 環境

- macOS 26.4.1（25E253），Apple Silicon arm64。
- VS Code 1.142.0，arm64；本機工作區，不是 Remote／WSL／Container。
- 本輪 CLI 測試 Node.js 26.0.0、Swift 6.2；專案 CI 保留 Node 20／22。這不是 Extension Host 內建 Node 版本的量測。
- 使用者人工開啟啟動程式的螢幕錄製／輔助使用權限。正常桌面執行時 helper 的兩項 preflight 均為 true；受限制的執行環境仍可能回 false，不會據此聲稱使用者未開權限。

## 已執行

1. `npm test`：434 tests，0 failures／skips。包括 macOS backend 選擇、Bundle／登入視窗排除、視窗身分傳遞、拒絕／取消／舊 observation、helper 缺失，以及既有唯讀 Agent 邊界。
2. `npm run desktop:macos:fixture`：實際編譯並啟動自己的 AppKit `.app`，只選取該 Bundle 和視窗 ID。ScreenCaptureKit PNG、中文與英數輸入、AXPress 按鈕、基本單鍵及 AX 垂直捲軸，均以合成程式實際結果驗證。舊幾何、越界座標、已關閉視窗與安全輸入欄位拒絕；輸入途中取消後下一次輸入恢復。未擷取或操作使用者的其他視窗，也未讀取剪貼簿，沒有學校請求。
3. `npm run sandbox:fixture`：實際 Seatbelt 阻擋工作區外檔案、`.env` 和網路；允許核准工作區／scratch，stdio MCP 真正握手與呼叫成功。
4. `npm run ocr:fixture`：真正 Tesseract／Poppler 解析乾淨圖片／PDF，拒絕合成憑證。
5. `npm run capabilities:fixture`：隨包圖表／流程圖及離線 WASM OCR，含秘密阻擋與失敗後清理。
6. `npm run browser:fixture`：Chrome 合成網站登入視窗／關閉後背景交接、Profile、串流、附件、長文、取消、UI 通過。沒有使用學校 SSO 或真實模型。
7. `npm run computer:fixture`：Chromium 工作瀏覽器實際 Unicode fill、click、操作後觀察、登入欄位／iframe 攔截通過。
8. `npm run package`：原生 darwin-arm64 VSIX，核對版本、helper 的 arm64 Mach-O、執行權限及封裝來源。使用者不需 Swift；Swift 僅供開發／打包主機使用。

## 原生後端的範圍

需要 macOS 14+。點擊／捲動限定可核對的 AX 控制項，自繪畫布或缺少 AX 動作不回退全域滑鼠。Unicode 仍需操作後觀察確認，不能保證任意輸入法與程式相容。每次觀察／動作仍獨立核准；僅在成功觀察結果後才解除主任務的待驗證狀態。

實作參考 Apple 官方的 [CGWindowListCopyWindowInfo](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:))、[CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent) 與 [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)。沒有使用私人 API、剪貼簿、一般瀏覽器 Profile、全螢幕截圖或任意主機 Shell。

## 尚未驗收

- Intel Mac 原生桌面、其他 macOS 版本、權限撤銷／不同應用程式的實際操作矩陣。
- 新版在 VS Code 的完整真人 SSO／真實校方模型／重啟後恢復鏈路；localhost fixture 不算真人證據。
- Windows／Linux 新後端與 ARM64 套件，不能透過這台 Mac 完成原生驗收。

因此 #3、#6 的全部驗收條件尚未滿足，不應直接關閉 Issues。完整操作、權限及限制見 [Computer Use](PLUGIN_COMPUTER_USE.md)。
