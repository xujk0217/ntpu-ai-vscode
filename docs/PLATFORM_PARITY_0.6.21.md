# 0.6.21 平台功能與流程對照

0.6.21 的 Agent、聊天、Session／Checkpoint、Project Memory、核准模式、工具發現、唯讀子任務、串流長文分段、回覆逾時監測、格式修復與重複讀取收斂都來自同一份 JavaScript 程式，三平台安裝包不包含分叉的 Agent 流程。平台差異主要在 OS 沙箱、終端機與原生桌面控制。

| 能力 | Linux x64 | Windows x64 | macOS arm64／x64 |
| --- | --- | --- | --- |
| Agent／聊天／本機歷史／記憶／核准／工具／子任務／長文 | 共用流程 | 共用流程 | 共用流程 |
| Agent 模型等待 | 同一閒置期限設定，收到新內容會延長；設定最高 600 秒，單次總期限最高 15 分鐘 | 同左 | 同左 |
| 專用登入瀏覽器 | Playwright 控制的 Chromium 系瀏覽器；Auto 偏好系統支援候選 | Playwright 控制 Edge／Chromium | Playwright 控制 Chrome／Chromium |
| 登入視窗與背景交接 | 同一專用 Profile，先關閉舊 context 再切換 | 同左 | 同左 |
| Shell／stdio MCP 隔離 | bubblewrap；需 Node 22.12+、bubblewrap、socat、ripgrep | **目前拒絕執行**；不能回退一般 shell。sandbox-runtime 的 Windows Alpha 實作未接入本擴充，亦未經 Windows 實機驗收 | macOS Seatbelt；需 Node 22.12+ |
| shell 命令列 | POSIX shell | cmd.exe，相容命令集合不同 | POSIX shell |
| Computer Use 瀏覽器 | 支援 | 支援 | 支援 |
| Computer Use 原生桌面視窗 | 僅 X11／XWayland；Wayland 原生視窗不支援 | 不支援 | 不支援 |
| 原生 VSIX | `linux-x64` | `win32-x64` | `darwin-arm64`、`darwin-x64` |

## Windows 與 Linux 流程差異

Agent 的模型請求、每輪新校方對話、本機上下文與工具收據流程相同。Windows `run_command` 使用 cmd.exe 且基本核准指令集合不同；目前 OS 沙箱 API 不允許 Windows Shell／stdio MCP 執行，所以這些操作會明確停止。檔案工具、HTTPS MCP、受控工作瀏覽器仍按共用權限流程執行。原生 Computer Use 桌面視窗則只在 Linux X11／XWayland 可用。

本次 Linux 真實 UI 測試中，模型首字最慢約 61.2 秒、整輪最慢約 95.9 秒；沒有觀察到 240 秒提早中斷或 600 秒靜默逾時。三個合成專案最後都因模型輸出混合或無效的 JSON／XML 工具封裝而未完成，另有一個桌面測試先遇到 Extension Host 不可見的 socat／Node 執行環境。這些證據解釋了「工具結果看似已完成、任務仍未完成」及重複工作的 Linux 案例，但不能單獨證明 Windows 使用者遇到的相同根因；目前沒有 Windows 實機逐案重現證據。

0.6.21 對共同問題加入三層收斂：唯一完整 JSON 封裝可從簡短敘述中恢復；任何多個／混合 XML、JSON 操作仍拒絕執行；已讀過且內容未變的完整行區段只回傳短收據；確認 Shell 相依或命令不存在並取得一項後續安全查證後，直接回報實際阻礙、保留未完成狀態並停止無進展迴圈。測試證明改動不會將矛盾操作當成有效工具，也不會把環境阻礙標記成成功。

## 發行與驗證範圍

CI 必須在 Windows Server 2022、macOS Intel／Apple Silicon 與 Ubuntu Linux，分別以 Node 20／22 跑回歸測試；四種 VSIX 由對應 OS 的 Node 22 工作原生打包。Linux OS 沙箱及瀏覽器 fixture 已在此工作站測試；Windows／macOS 的真人 SSO、OS 桌面控制及 Windows Shell／stdio 仍不可宣稱通過。VSIX 發布前需全部原生 CI job 成功。

Windows 官方 sandbox-runtime 文件將後端標為 Alpha，要求機器管理員一次性建立隔離帳號與 WFP 網路規則；本擴充目前不自行執行該系統層安裝。參考：[sandbox-runtime Windows Alpha 文件](https://github.com/anthropics/sandbox-runtime#windows-alpha)。
