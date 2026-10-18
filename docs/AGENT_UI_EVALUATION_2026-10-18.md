# Linux VS Code 桌面 Agent 實測（2026-10-18）

本報告補充 [核心／App adapter 測試](AGENT_EVALUATION_2026-10-18.md)。這次透過真正的 Snap VS Code 聊天面板送出任務，沒有以外部 runAgent harness 代替桌面操作。基準為已安裝的 0.6.20；工作區中的未發行修正沒有安裝到這次基準。

## 方法

原生 Computer Use 沒有暴露 VS Code 桌面控制，經使用者明確同意，使用 Linux xdotool、Gdk 截圖操作真正 VS Code。產物網頁以 Computer Use 的 in-app browser 點擊與讀取可見 DOM 驗證。xdotool、socat 與 libwrap 從 Ubuntu 套件解出到專案私有 `.local`，沒有 sudo 或系統安裝。沒有關閉 Chromium／shell sandbox。

兩個空白工作區位於 `/home/xujunkai/Developer/ntpu-agent-ui-evaluation-20261018/{breakout,calculus}`。各設回覆閒置期限 600 秒、100 輪、64,000 字元，關閉新聊天網路開關；使用原本所有聊天共用的完整存取偏好。原先 workspace 的 parallel.maxConcurrency=2 不適用 application scope，實際為自適應 2→3→4，不能宣稱固定兩個名額。

只讀取這兩個合成工作區自己的 Session／checkpoint，沒有讀取其他聊天本文、Cookie、Token、SSO 憑證或日常瀏覽器 Profile。證據、prompt、截圖與合成 Session 副本保存在上述根目錄的 `evidence`，不提交含本機路徑的原始 Session 到 Git。

## 打磚塊遊戲

要求純 HTML/CSS/JS、鍵盤與滑鼠／觸控、球拍、磚塊、分數、三條命、開始／暫停／重設、勝負、bounded dt、可測核心、至少八項測試與 README。Agent 寫出六個主要檔案，並自行修正 overlay 的 hidden CSS 與畫布比例。

實際 Extension Host 執行指令得到 `OS 沙箱依賴不可用：socat not installed`。Agent 重試後繼續重讀程式，初次有 34 次 read_file；操作者透過停止按鈕停止，並非 600 秒網站逾時。當次清理刪除 38 個自有測試對話，但 UI 仍有部分清理失敗警告，不能宣稱全部清理成功。

退出此測試 VS Code，將私有 socat wrapper 加入本次啟動 PATH 後重新開啟相同工作區。沙箱 fixture 通過，但真正 Extension Host 仍出現 `node: command not found`：主機 Node 在 ~/.nvm，既有隔離 runtime roots 沒有掛入該路徑。Agent 探索後找到既有允許路徑 `/usr/lib/chatgpt/resources/cua_node/bin/node`，並在 Linux bubblewrap、禁止網路下實際跑出 **11/11 測試通過**。

測試指令帶 `| tail`，因此通過證據是輸出明確顯示 tests 11 / pass 11 / fail 0，不能只使用管線退出碼 0 作判斷。

真實瀏覽器驗證：開始後球運動、實際得分 10 並失去一條生命；開始後暫停顯示「已暫停」、按鈕轉為「繼續」；重設回到分數 0、生命 3、準備開始。勝利僅有單元測試，未宣稱真人完整過關、完整觸控或跨裝置驗收。畫面證據：[實際得分／失血時的暫停畫面](../../ntpu-agent-ui-evaluation-20261018/evidence/breakout-paused.jpg)；第二次瀏覽器重置後的 [重新開始畫面](../../ntpu-agent-ui-evaluation-20261018/evidence/breakout-final.jpg)。

接續最後多次輸出不支援的 XML invoke 工具格式，格式修復後仍失敗，App 標記 blocked、任務未完成。README 存在但測試說明未同步，計畫仍未完成；因此**可玩與測試通過不等於 Agent 端到端成功**。

重啟前後比較這個測試聊天室的原始 96 則訊息：遺失 0、文字改變 0；接續後 122 則。相同專用 Profile 的有效學校登入可接續，未要求重新 SSO。沒有手動修改 Session／Project Memory。

## 微積分計算機

要求以無套件 HTML／CSS／JS 製作安全的有界運算式解析器、中央差分導數、自適應 Simpson 積分、錯誤處理、圖形、至少八項測試及 README。Agent 產生 parser、calculus、app、頁面、樣式、13 個 node:test 案例與 README。README 為 128 個英文空白分隔字，低於 500 字。

VS Code 實際網頁操作得到：x² 在 3 的一階導數 6；[0,1] 積分 0.333333；sin(x) 在 [0,π] 積分 2；反向積分 -0.333333。`x;alert(1)` 被語法拒絕；1/x 跨 [-1,1] 回報除零；負數開根號回報定義域錯誤；積分評估上限設為 10 時安全中止並說明原因。瀏覽器 console error 為 0。畫面證據：[計算機結果與圖形](../../ntpu-agent-ui-evaluation-20261018/evidence/calculus-final.jpg)、[打磚塊暫停畫面](../../ntpu-agent-ui-evaluation-20261018/evidence/breakout-final.jpg)。

13 項測試實際在 Agent 的 bubblewrap shell 輸出 **13 pass、0 fail、exit 0**；其中測試涵蓋導數、積分、運算子優先、錯誤語法、定義域、奇異點、非有限數、評估上限、工作量、繪圖取樣及禁止 eval/Function。另在 Extension Host 外的本機 Node 直接執行 `node test/calc.test.js`，亦得到 13/13。`node --test` 在這台 Node 24 的外部呼叫只回報檔案層級 1/1，因此合成 README 已改成明確的直接測試指令，避免把單一檔案計成 13 項。

Agent 接收 UI 實測引導後仍多次重讀檔案，最終連續回傳無效工具格式並把任務標成 blocked；最後保存的計畫仍停在「撰寫測試」，即使測試和 README 已存在。這些生成與驗收結果證明計算機可用，但 Agent 的計畫收尾／格式傳輸端到端**未成功**。最後一段模型輸出首 token 約 51.2 秒，單次請求完成約 51.4 秒；期間未遇到 240 秒逾時、空白回答或 600 秒靜默逾時。

## 已辨識的改善方向

1. 工具預檢應在模型花費輪數前確認 shell sandbox 依賴與實際隔離環境內的 runtime 可執行性。外部 CLI 的 Node 可用，不代表 Electron Extension Host 的隔離環境可用。不得為此任意掛入整個家目錄或敏感 runtime 設定。
2. socat 缺失、node 缺失是工具能力阻礙，應提供具體錯誤及可恢復的暫停狀態；沒有新證據時不要繼續大量重讀檔案。
3. 網站有正常串流、卻輸出錯誤工具封裝，應記為格式失敗。需針對控制 schema、有限格式修復與大檔工具輸出改善，不能靠延長 timeout 解決。
4. 完成狀態應對照測試收據、文件與計畫，不能只依模型總結。保留目前無效工具不執行、未完成不標成功的行為。

## 邊界

本次只涵蓋這台 Linux 的已安裝 0.6.20。沒有 Windows／macOS、真人重新登入、校方尖峰或連續多日耐久證據。頁面使用 localhost，只服務這兩個合成專案；沒有安裝外部網頁套件。測試報告不代表尚未發行的修正已安裝或已發布。
