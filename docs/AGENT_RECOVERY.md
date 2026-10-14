# Agent 調查與恢復流程

## 目標

遇到一般工具失敗時，Agent 應繼續查證並嘗試可行方法，直到任務完成、證據確認受阻、使用者停止或共用輪數預算用完。查資料本身不代表原本失敗的操作已成功。

## 流程

1. 保留實際錯誤與已成功工具結果，不重做已完成修改。
2. 檢查當前檔案與執行條件；透過 `get_capabilities` 或 Skills 確認真正可用的工具。
3. 原因或修復方法不明時，使用已啟用的網路／MCP 查官方文件。只傳送必要、已遮蔽的錯誤關鍵字，不上傳私人檔案、憑證或整份終端機輸出。
4. 簡短整理證據與替代方法，實際執行不同方法，再以工具結果確認。
5. 完成才回報完成；受阻時說明已嘗試的方法、剩餘工作與具體缺少的能力。

主機在收到 final 時也會檢查尚未恢復的工具失敗，即使模型漏填 `completed:false`，仍要求接續調查。每個任務最多六次恢復檢查；有新工具證據可繼續，連續兩次檢查沒有新增實質工具證據則停止，且結果保持未完成。純粹更新計畫、重複同一份工具結果不能當成新證據。所有調查、研究與嘗試都消耗原本共用輪數，不額外建立無限預算。

這不是自動重送副作用操作；下一個工具由 Agent 根據實際結果選擇，仍經過原有權限、沙箱與路徑檢查。HTTP 429、登入失效、明確服務限制、取消、保存失敗及使用者拒絕不使用這個流程繞過。模型傳輸錯誤仍沿用原本最多兩次有限恢復機制。

## 工作區網頁開啟

`open_browser({"path":"calculus.html"})` 透過 VS Code `env.openExternal` 交給系統預設瀏覽器，避免沙箱 shell 的 `open`／`xdg-open` 無法與桌面服務連線。

- 限目前受信任工作區內的一般 `.html`／`.htm` 檔案。
- 路徑穿越、受保護檔案、外部 symlink、秘密內容與需審核資料拒絕開啟；核准後重新驗證。
- 要求核准與協助模式顯示開啟核准；完整存取或工作階段工具授權依既有權限規則執行。唯讀 Agent／Subagent 不取得此能力。
- 頁面中的 JavaScript 會在外部瀏覽器執行，可能連網；核准提示顯示這件事。
- 回傳 `opened:true` 只表示系統接受開啟請求，`verified:false` 表示尚未驗證畫面或互動。
- 遠端工作區不能以本機檔案路徑假裝開啟；應使用已設定的預覽或轉送流程。

## 設計參考

- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)：自主探索、持續完成任務、偏好專用工具，以及避免沒有進展的重複。
- [Build iterative repair loops with Codex](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex)：把驗證失敗作為下一輪修復證據。
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)：工具由主機執行，再把實際結果交回模型；模型本身不執行函式。
- [DeepSeek Harness Agent Lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/reference/agent-lifecycle)：保留已結算嘗試與工具脈絡，以新的恢復進展作為接續依據。
- [DeepSeek Harness Tool Execution Pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline)：權限、沙箱和檔案 guard 維持於工具執行流程內。
- [VS Code API](https://code.visualstudio.com/api/references/vscode-api#env)：`openExternal` 交付外部應用程式並回傳開啟結果。

以上是適配到現有 NTPU AI 網頁工具迴圈的設計參考，沒有把模型更換為 DeepSeek 或使用 OpenAI API。
