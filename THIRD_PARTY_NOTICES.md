# 第三方套件與參考來源

根目錄 MIT License 適用於本專案原創程式碼。安裝包包含的套件及其轉移依賴保留各自隨附的 LICENSE／NOTICE；本文件不是完整轉移依賴授權替代品。確切版本由 package-lock.json 鎖定。

## 主要套件

| 套件 | 用途 | 授權 |
| --- | --- | --- |
| @modelcontextprotocol/sdk | MCP client 與 transports | MIT |
| playwright-core | 正常 Chrome 網頁橋接 | Apache-2.0 |
| markdown-it | Markdown 呈現 | MIT |
| highlight.js | 程式碼高亮 | BSD-3-Clause |
| diff | 修改差異 | BSD-3-Clause |
| jsonc-parser | JSONC 設定讀取 | MIT |
| sharp | 縮圖及 SVG 轉 PNG | Apache-2.0；原生函式庫另有授權 |
| saxes | SVG XML 驗證 | ISC |
| yaml | Skill frontmatter | ISC |

## 架構與互動參考

- [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)：瀏覽器工作階段搭配本地工具迴圈的概念。
- [microsoft/vscode](https://github.com/microsoft/vscode)：工具紀錄、終端機核准設定的互動設計；參考 terminalChatAgentToolsConfiguration.ts。
- [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat)：公開原始碼與介面操作方式。
- [OpenCode](https://opencode.ai/docs/)：Agent、permissions、SKILL.md 的使用方式。

此版本自行實作側欄與 Agent，沒有直接複製上述產品的 UI 原始碼、商標或資產。保留參考來源不表示這些專案作者為本專案協作者，亦不表示官方整合或背書。
