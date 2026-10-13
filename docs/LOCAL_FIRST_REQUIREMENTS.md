# NTPU AI Agent：Local-first Memory System 與敏感資料防護重構

## 一、專案背景與開發目標

請協助重構以下 GitHub 專案：

https://github.com/xujk0217/ntpu-ai-vscode

本專案是透過 NTPU AI 網頁介面提供模型推論能力的 VS Code Coding Agent。現有系統使用 Playwright 控制專用 Chrome，透過 BrowserBridge 與 NTPU AI 互動，再由本地 Agent 執行檔案操作、終端機指令、MCP 工具與其他開發任務。

目前已具備：

- 多輪 Agent 工具呼叫與執行機制。
- 本地 SessionStore 與工作階段管理。
- 專案檔案讀取、修改、diff 與回復。
- Agent 執行檢查點與基本歷史紀錄。
- 使用者權限確認與工具執行限制。
- 基本敏感路徑防護。

但目前的記憶管理仍存在一些問題，例如歷史訊息保存數量受限、長期脈絡不足、上下文管理過度依賴最近幾輪對話，而且缺乏完整的敏感資料流向管理。

本次希望建立一套更完善的 **Local-first Agent Memory Architecture**。

核心設計原則：

**本機負責記憶，Agent 負責執行，NTPU AI 只負責模型推論。**

請先閱讀目前儲存庫的完整相關程式碼，確認現有行為與依賴關係，再依照以下規格完成實際程式修改。

不要假設 README 的描述與程式碼完全一致，應以實際程式碼為準。

---

# 二、功能一：Local-first 長期記憶系統

## 2.1 核心設計目標

我希望 VS Code 的 Agent Session 與 NTPU AI 網頁聊天室完全解耦。

本機 Session 才是對話歷史、任務狀態與專案記憶的主要資料來源。

NTPU AI 網頁聊天室應被視為暫時性的模型推論通道，而不是必要的歷史資料庫。

系統必須滿足：

1. 使用者可以在同一個 VS Code Session 中持續進行多次不同任務。
2. 每次使用者任務可建立獨立的 NTPU AI 網頁聊天室。
3. 同一個任務中的多次 Agent 推論可以沿用同一個暫時聊天室。
4. 後續任務不能依賴前一次網頁聊天室的歷史。
5. 使用者切換 NTPU AI 帳號後，仍可使用原本的本機 Session。
6. 使用者重新啟動 VS Code、關閉 Chrome 或登入過期後，仍可恢復原本的專案工作。
7. 本機的完整歷史應能持續保存，不因為網頁聊天紀錄消失而遺失。
8. 即使未來替換模型 Provider，記憶資料也可以繼續使用。

請保留目前一個使用者任務可以執行多輪 Agent Tool Loop 的機制，不要退回每次工具呼叫都建立新聊天室的模式。

### 網頁聊天室與本機 Session 的生命週期

本機 Session：

- 由使用者建立、選擇、重新命名、封存及刪除。
- 可以包含多個使用者任務。
- 不因 NTPU AI 登出、切換帳號或新建網頁聊天室而被清除。

網頁 Conversation：

- 在新的使用者任務需要模型時建立。
- 同一任務的 Agent Tool Loop 可以持續使用。
- 任務完成、停止或失敗後，不應再依賴該聊天室作為歷史來源。
- 保留未來透過官方網頁正常介面刪除暫時聊天室的擴充點。

本次不應自行猜測或呼叫未公開的遠端刪除 API，也不應聲稱刪除聊天室等於完全清除校方所有資料。

---

## 2.2 三層記憶架構

請將 Agent 記憶分成以下三個層級。

### A. Project Memory：專案長期記憶

保存跨 Session 仍然有用的專案資訊，例如：

- 專案用途及主要目標。
- 技術架構及使用的 Framework。
- 重要模組及檔案分工。
- 已確認的程式設計慣例。
- 重要技術決策及原因。
- 已完成的主要功能。
- 已知問題、技術限制及待辦事項。
- 使用者對此專案的長期偏好。

例如使用者正在開發 Next.js 專案：

Project Memory 可以記住：

- 使用 Next.js App Router。
- 主要使用 TypeScript。
- 驗證方式使用 NextAuth。
- UI 使用 Tailwind CSS。
- 使用者希望維持既有的檔案命名慣例。
- 尚有特定 API 模組需要重構。

這些資訊不必在每次新對話中重新詢問。

但是，Project Memory 不應被視為永遠正確。

涉及目前程式碼、依賴版本、檔案內容與測試結果時，Agent 必須以當前專案實際狀態重新驗證。

### B. Session Memory：工作階段記憶

每個 Session 應保存：

- 完整使用者與 Agent 對話歷史。
- 工具操作紀錄。
- 任務執行狀態。
- Agent 計畫與任務進度。
- 重要修改與檢查點。
- 最近一次任務的結果。
- 尚未完成的工作。
- Session 摘要。

同一個專案可以存在多個 Session。

例如：

Project：NTPU One

Session A：重新設計登入系統。

Session B：修正 Firestore 查詢。

Session C：優化 SwiftUI 介面。

不同 Session 的完整對話彼此獨立，但可以共用 Project Memory。

### C. Task Memory：單次任務記憶

每一次使用者 Request 建立一個 Task。

Task 應保存：

- 原始使用者需求。
- 任務開始及完成時間。
- Agent 工具呼叫與實際結果。
- 本次修改的檔案。
- 測試與驗證結果。
- 任務是否已完成。
- 失敗原因或未完成工作。
- 可以恢復的執行檢查點。

如果 Agent 因為達到步數限制、使用者停止或系統異常而中斷，應能透過本機資料恢復工作。

恢復時必須重新檢查工作區現況，不可直接假設舊檢查點中的檔案內容仍然有效。

---

## 2.3 本機持久化儲存

請檢查目前 `src/sessions.js`、`src/app.js` 和 VS Code `workspaceState` 的儲存方式。

目前系統存在固定數量的 Session、訊息與最近問答保存限制。

希望改成能長期保存完整對話的本機持久化架構。

請遵守以下要求：

1. 儲存位置使用 VS Code 提供的 `globalStorageUri` 或其他合適的本機應用資料目錄。
2. 不要預設將私人聊天紀錄放入 Git 專案資料夾。
3. 不要將私人對話自動加入 Git 版本控制。
4. 不再直接以固定 25 個 Session、每個 Session 100 則訊息作為唯一保存上限。
5. 支援歷史訊息分頁載入，避免一次載入全部訊息造成 Webview 效能問題。
6. 必須支援完整 Session 切換及重新開啟。
7. 寫入應避免異常中斷造成歷史資料損毀。
8. 實作原子寫入或其他可靠的持久化策略。
9. 避免非同步寫入競爭造成舊資料覆蓋新資料。
10. 設計資料 Schema Version，以便未來遷移。
11. 對舊版 Session 資料進行安全遷移。
12. 資料遷移不得默默刪除既有使用者紀錄。
13. 可提供匯出、備份與還原功能。
14. 不應因為達到容量門檻就悄悄刪除歷史。

可以評估 JSONL、SQLite 或其他合適的本機資料庫，但請考慮 VS Code Extension 的跨平台支援、打包、原生依賴、維護成本和可靠性。

優先選擇架構清楚、容易測試、可以長期維護的方案。

若需要新增依賴，請說明原因，不要為了簡單功能引入大型框架。

---

## 2.4 智慧上下文管理

這是本次最重要的功能之一。

雖然本機應保存完整聊天歷史，但 **不應將所有歷史訊息全部傳送給 NTPU AI**。

請建立 Context Manager，在每次模型呼叫前組合最合適的上下文。

建議上下文結構：

```text
System / Agent Instructions
         ↓
Current User Request
         ↓
Relevant Project Memory
         ↓
Current Session Summary
         ↓
Relevant Previous Tasks
         ↓
Recent Conversation
         ↓
Current Workspace Context
         ↓
Actual Tool Results
```

請建立合理的 Context Budget 機制。

優先保留：

1. 當前使用者需求。
2. Agent 操作協定與工具安全規則。
3. 當前任務必要的工具結果。
4. 相關且已驗證的專案資訊。
5. 未完成的任務狀態。
6. 最近相關對話。

較舊、重複或不相關的歷史可以不加入模型輸入，但不能因此刪除本機原始紀錄。

### Context Retrieval

當使用者提出新任務，例如：

「繼續修改之前那個登入系統。」

Agent 應能在本機查詢：

- 與登入相關的先前任務。
- 當時修改的檔案。
- 尚未解決的問題。
- 重要設計決策。

而不必重新載入所有歷史聊天。

初期可以採用：

- Keyword Matching。
- Session / Task Metadata。
- 檔案路徑關聯。
- 最近任務權重。
- 簡單的相關性評分。

不要求一開始就建立 Embedding 或 Vector Database。

請將 Retrieval 設計成可擴充的模組，未來可以替換成 Semantic Search。

---

## 2.5 Memory Summarization 與更新

請實作可持續更新的記憶摘要機制。

當任務結束時，整理真正有長期價值的資訊。

例如：

```json
{
  "project": "Example Project",
  "architecture": [
    "Next.js App Router",
    "TypeScript"
  ],
  "decisions": [
    {
      "topic": "Authentication",
      "decision": "Use NextAuth",
      "reason": "Existing project integration"
    }
  ],
  "completedTasks": [
    "Implement login API"
  ],
  "pendingTasks": [
    "Add password reset"
  ]
}
```

上述為資料結構示例，不要求使用完全相同的 Schema。

記憶更新應符合：

- 優先從實際工具執行結果取得可驗證資訊。
- 不得把 Agent 提出的計畫直接當成已完成成果。
- 不得把測試預期結果當成測試成功。
- 記錄重要資訊的來源，例如 Task ID、檔案路徑或驗證時間。
- 同一資訊更新時，避免產生互相矛盾的記憶。
- 過時記憶應能標記為 Stale 或被新證據取代。
- 對無法確認的內容應保存其不確定性。

如果使用模型協助產生摘要，必須先通過敏感資料防護，並計入正常模型請求額度。

不要在背景無限制呼叫 NTPU AI 來建立摘要。

應提供手動重新整理記憶的能力。

---

## 2.6 跨帳號恢復能力

本機 Session 不能與 NTPU AI 帳號強制綁定。

例如：

使用者原本登入 Account A，進行了 30 次開發任務。

之後登出 Account A，改用 Account B。

系統應能：

1. 保留原本所有本機 Session。
2. 保留 Project Memory。
3. 保留已完成任務與重要決策。
4. 繼續瀏覽原本的聊天歷史。
5. 使用新帳號的 NTPU AI 建立新聊天室。
6. 把必要的本機上下文交給新聊天室。
7. 從原本進度繼續執行任務。

帳號切換不能清除本機記憶。

不應為了恢復工作而讀取或重新使用前一帳號的 Cookie、Token 或瀏覽器 Session。

如果重新登入失敗，仍應允許使用者離線瀏覽本機歷史與記憶。

模型推論能力可以暫時不可用，但本機資料應保持可讀。

---

# 三、功能二：敏感檔案與資料外洩防護

## 3.1 防護目標

目前 Agent 可以讀取工作區檔案、執行 Shell 指令、使用 MCP，並將結果傳送給 NTPU AI。

這代表敏感資訊可能透過多個路徑離開本機。

需要建立統一的 Sensitive Data Protection Layer。

防護範圍至少包含：

- 本機檔案讀取。
- 使用者附加檔案。
- Editor Context。
- Workspace Context。
- 專案文字搜尋。
- Terminal / Shell Output。
- MCP Tool Results。
- 外部 Web Search / Fetch。
- Agent Prompt 組合。
- Session Memory。
- Project Memory。
- Checkpoint。
- Log 與 Debug Output。
- 匯出聊天紀錄。

不能只在 `read_file` 增加黑名單，就認為已經完成敏感資料保護。

---

## 3.2 敏感路徑辨識

請檢查目前 `src/workspace.js`、`isBlocked()`、`safePath()` 與相關工具的實作。

建立集中管理的敏感路徑規則。

至少考慮以下類型：

```text
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa
id_ed25519
.npmrc
.pypirc
.aws/credentials
.kube/config
.ssh/
Secrets/
Credentials/
service-account*.json
*-service-account.json
```

以及其他常見的：

- Cloud Provider Credentials。
- SSH Private Keys。
- API Token 設定。
- Database Credentials。
- OAuth Client Secrets。
- CI/CD Secrets。
- 含密碼的本機設定檔。

注意：

`.env.example`、`.env.sample` 等檔案不一定包含真正的秘密，應依路徑風險與實際內容分類，避免產生大量不必要的誤判。

另外還要防止：

- 相對路徑穿越。
- 絕對路徑繞過。
- Symlink 指向工作區外檔案。
- 不同作業系統的路徑格式差異。
- 大小寫與路徑正規化差異。
- 使用 Glob 或搜尋工具意外取得受保護檔案。

請維持現有 Workspace Boundary 安全機制，不得因為重構而放寬。

---

## 3.3 敏感內容偵測與遮蔽

除了路徑防護，還需要分析即將送往模型的文字內容。

至少能辨識：

- Private Key Blocks。
- API Keys。
- Access Tokens。
- Bearer Tokens。
- JWT。
- Password / Secret 欄位。
- Database Connection Strings。
- 常見 Cloud Provider Credentials。
- 可能包含高敏感度憑證的 URL。

請建立類似以下的集中模組：

```text
SensitiveContentGuard
  ├── classifyPath()
  ├── classifyContent()
  ├── redact()
  ├── inspectOutboundPayload()
  └── explainDetection()
```

實際命名可依現有專案風格調整。

當模型需要理解含敏感資訊的設定檔時，應盡可能保留其非秘密結構。

例如：

原始內容：

```env
DATABASE_URL=postgresql://admin:example-password@localhost:5432/app
API_KEY=example-secret-value
PORT=3000
```

送往模型前：

```env
DATABASE_URL=[REDACTED_CONNECTION_STRING]
API_KEY=[REDACTED_SECRET]
PORT=3000
```

其中示例值不是實際金鑰。

遮蔽後應保留足以理解程式結構的必要資訊，但不能把原始憑證放在提示、工具紀錄或長期記憶中。

### 偵測策略

請使用多層策略：

1. 已知敏感檔案路徑規則。
2. 常見 Secret 格式辨識。
3. 關鍵欄位及上下文判斷。
4. 必要時使用 Entropy 輔助偵測。
5. 可解釋的風險分類。

請避免單靠高 Entropy 就把所有 Hash、UUID、測試資料和一般程式碼全部當成秘密。

安全性應優先於便利性，但也要降低誤判。

---

## 3.4 防護模式與權限控制

請建立統一的資料存取政策。

建議至少分為：

**Protected**

明確敏感的憑證或密鑰檔案。

預設禁止 Agent 自動讀取及傳送原始內容。

**Review Required**

可能含有私人或機密資訊的檔案。

例如一般設定、營運資料或使用者指定的保密檔案。

發送前需要清楚的使用者確認。

**Normal**

一般程式碼、公開文件與非敏感資料。

依照現有 Agent 權限模式正常使用。

重要要求：

- `full access` 不代表可以自動將密鑰傳送至模型。
- 使用者可以針對需要處理的非密鑰敏感檔案進行單次授權。
- 即使使用者確認，偵測到的高風險憑證原文仍應預設遮蔽。
- 不要建立容易被 Agent Prompt 或專案檔案內容繞過的權限機制。
- 權限與資料保護規則必須由本地主機程式強制執行，而不是僅透過模型 Prompt 要求遵守。

對於無法安全處理的內容，應停止該次資料傳送並解釋原因。

---

## 3.5 統一的模型輸出邊界

所有即將送往 NTPU AI 的資料，必須通過同一個 Outbound Data Guard。

例如：

```text
Workspace / Editor / Files
              ↓
         Local Tools
              ↓
      Context Assembly
              ↓
    Sensitive Data Guard
              ↓
      Redact / Block
              ↓
        BrowserBridge
              ↓
           NTPU AI
```

請確保：

- 沒有工具可以繞過這道防護直接傳送任意工作區內容。
- 讀取檔案時可進行第一層檢查。
- 最終組合模型輸入時再次檢查。
- MCP 工具結果不能因為來自外部工具就自動視為可信。
- 文字搜尋結果中的秘密也需要遮蔽。
- 使用者直接附加檔案時，應檢查風險並清楚告知會傳送到哪個服務。
- Web Search 查詢不得意外包含本機秘密。
- URL 中的敏感 Query Parameters、Authorization Header 及其他憑證不得出現在普通工具紀錄中。

同時請避免重複遮蔽後造成上下文格式嚴重損毀。

---

## 3.6 Terminal 與 MCP 風險

這部分需要特別注意。

目前本地 Shell 與 stdio MCP 以使用者作業系統權限執行，並不具備完整的 OS Sandbox。

因此，單純增加敏感檔案黑名單，無法阻止任意 Shell Script 或第三方 MCP 自行讀取秘密並經網路傳送。

請在本次重構中：

1. 保留現有 Terminal 權限確認。
2. 明確顯示可能進行外部資料傳送的指令風險。
3. 避免將含秘密的 Terminal Output 原文送給模型。
4. 對 MCP Tool Results 進行敏感資料檢查。
5. 對外部 MCP 工具保留個別授權。
6. 不要把 Agent 回傳的文字視為可信指令。
7. 不要宣稱這套措施能完全隔離所有惡意 Shell 或 MCP 行為。

若要進一步阻止任意程式存取本機檔案及網路，需要真正的 OS Sandbox 或其他隔離技術。

本次至少應完成 Host 層可以實際強制執行的防護，並在文件清楚說明剩餘限制。

---

# 四、記憶系統與安全防護的整合

這兩個功能必須一起設計，不能只是各自獨立實作。

例如：

Agent 曾經讀取一份含 API Key 的設定檔。

即使模型輸入已成功遮蔽，仍須確保該 Key 不會被保存到：

- Session History。
- Project Memory。
- Task Memory。
- Checkpoint。
- Tool Result Cache。
- Diff Snapshot。
- Debug Logs。
- Exported Markdown。

請建立統一的資料處理流程：

```text
Raw Local Data
       ↓
Path Classification
       ↓
Content Classification
       ↓
Privacy Policy
       ↓
Sanitized Tool Result
       ↓
Context Manager
       ↓
Model Request
```

持久化資料也應在寫入前檢查，必要時對敏感欄位進行遮蔽。

### 重要原則

**不要因為資料已經儲存在本機，就認為它可以不經檢查直接發送到 NTPU AI。**

本機長期保存與外部模型資料傳輸，應有不同的安全界線。

使用者的聊天歷史也可能包含自行輸入的秘密，因此必須同樣納入檢查。

---

# 五、使用者介面

請在現有 VS Code Webview 中整合這些功能，延續目前 NTPU AI Agent 的視覺風格，不要重新設計整個 UI。

## 5.1 Session 管理

應提供：

- 新增 Session。
- 切換 Session。
- 重新命名。
- 搜尋歷史 Session。
- 刪除 Session。
- 刪除前確認。
- 匯出完整 Session。
- 查看未完成任務。

刪除本機 Session 不應自動刪除專案原始碼，也不應清空其他 Session。

## 5.2 Project Memory

增加可以查看的專案記憶介面。

至少顯示：

- 專案摘要。
- 技術架構。
- 重要決策。
- 已完成工作。
- 待辦事項。
- 最近更新時間。

使用者可以：

- 查看記憶。
- 手動修改記憶。
- 刪除個別記憶。
- 重新整理記憶。
- 關閉自動記憶功能。

建議增加記憶來源資訊，避免使用者無法判斷某項資訊是如何產生的。

## 5.3 Privacy Settings

增加隱私與資料保護設定。

例如：

```text
Memory & Privacy

[✓] Enable Local Project Memory
[✓] Auto Update Memory After Task
[✓] Protect Sensitive Files
[✓] Redact Secrets Before Model Requests

Sensitive File Handling:
  Protected / Review Required / Normal

Memory Storage:
  Local Machine

Actions:
  View Project Memory
  Export Sessions
  Delete Local Memory
```

不要讓使用者誤以為刪除本機資料等於刪除學校伺服器資料。

所有會造成資料刪除的操作，都需要適當確認。

---

# 六、程式架構與重構要求

請優先檢查以下檔案：

```text
src/app.js
src/agent.js
src/browser.js
src/sessions.js
src/protocol.js
src/workspace.js
src/tools.js
src/permissions.js
src/mcp.js
media/agent-ui.js
media/index.html
package.json
```

也請檢查相關測試及 README。

建議將責任分離成以下模組，實際檔名與類別可以調整：

```text
src/
  memory/
    memory-store.js
    project-memory.js
    session-memory.js
    task-memory.js
    context-manager.js
    memory-retrieval.js
    memory-migration.js

  security/
    sensitive-paths.js
    secret-detector.js
    data-redactor.js
    privacy-policy.js
    outbound-guard.js
```

不要為了符合建議目錄而機械式新增不必要的檔案。

重點在於：

- Storage 負責可靠的本機資料保存。
- Memory Manager 負責記憶更新與檢索。
- Context Manager 負責組裝模型需要的脈絡。
- Security Guard 負責敏感資料辨識與阻擋。
- BrowserBridge 只負責連線與模型請求。
- Agent 負責工具流程與任務執行。
- Webview 負責使用者操作與狀態呈現。

請避免把所有新功能直接堆進 `src/app.js`。

同時確保新的模組未來可以搭配其他 Model Provider 或 Agent Runtime，例如 OpenCode、Oh My OpenAgent，而不必重寫整個記憶系統。

本次不需要實作 Oh My OpenAgent 整合。

---

# 七、向下相容與資料遷移

必須保留現有功能：

- NTPU AI BrowserBridge。
- SSO 登入。
- Agent Tool Loop。
- Build / Plan / Review / Research / Ask。
- 權限核准。
- MCP。
- Skills。
- 終端機操作。
- 圖片與檔案工具。
- Diff 與回復。
- Session 切換。
- Markdown 匯出。

不得因重構破壞現有功能。

舊版 Session 資料必須可以升級到新格式。

遷移要求：

1. 優先保留舊版 Session ID 與歷史內容。
2. 遷移過程具備冪等性，避免重複匯入。
3. 寫入新格式失敗時，不得毀損舊資料。
4. 遷移前先建立必要備份。
5. 無法轉換的資料應提供錯誤紀錄。
6. 不得宣稱能恢復舊版本已經截斷或刪除的歷史。
7. 降低跨版本更新對使用者的影響。

---

# 八、測試與驗收標準

請新增必要的 Unit Tests 與 Integration Tests。

## Memory Tests

- 建立 Session 後重新啟動，歷史仍存在。
- 不同 Session 的內容不會互相覆蓋。
- 相同 Project 可以共享 Project Memory。
- 不同 Project 的記憶不會錯誤混合。
- 長對話不會因固定訊息數量限制而被截斷保存。
- Context Budget 超過限制時，能安全選取必要脈絡。
- 舊資料能正確遷移。
- 資料遷移重複執行不會重複建立紀錄。
- 程式異常結束後，已提交的紀錄仍可恢復。
- 不完整 Task 可以從本機 Checkpoint 接續。
- Agent 不會把尚未完成的工作記錄成已完成。
- 刪除 Session 不會刪除專案檔案。

## Cross-account Tests

使用 Mock BrowserBridge 模擬：

1. Account A 執行任務。
2. 將 Session 和 Memory 保存至本機。
3. Account A 登出。
4. Account B 登入。
5. 重新開啟原本的 Session。
6. 使用本機 Context 恢復原本任務。

驗證切換帳號後不需要取得 Account A 的網頁歷史。

## Security Tests

至少包含：

- `.env` 防護。
- SSH Private Key 防護。
- API Token 偵測。
- Bearer Token 遮蔽。
- URL Credentials 遮蔽。
- 敏感資訊出現在 Terminal Output。
- 敏感資訊出現在 MCP Result。
- 敏感資訊出現在 Search Result。
- 敏感資訊出現在 Editor Context。
- 敏感資訊出現在 Session History。
- 敏感資訊不會寫入 Project Memory。
- Symlink 與路徑穿越防護。
- `.env.example` 正常測試資料的誤判處理。
- 無敏感資訊時不會破壞正常模型輸入。
- `full access` 不會繞過模型資料外傳防護。

所有安全測試使用假的測試憑證，不要使用真實密鑰。

單元測試不應發送真正的 NTPU AI 請求。

如需執行網站 Smoke Test，必須另外說明，避免不必要地消耗學校服務資源。

## Build Verification

完成後執行現有專案提供的檢查：

```bash
npm ci
npm run build
npm test
```

如測試環境允許，再檢查 VSIX 打包。

若測試失敗，應嘗試修復，直到確認失敗原因。

不能僅因程式可以編譯，就宣稱所有功能都已通過測試。

---

# 九、開發執行方式

請以實際完成可運行的功能為目標。

建議依下列順序：

**Phase 1：分析現有架構**

- 確認 SessionStore、Context、Agent、BrowserBridge、WorkspaceTools 的資料流。
- 找出可能造成紀錄遺失、秘密外洩及資料混用的位置。

**Phase 2：建立本機 Memory Storage**

- 新的持久化資料格式。
- 舊資料遷移。
- Session / Project / Task 資料分離。

**Phase 3：建立 Memory Manager 與 Context Manager**

- Project Memory。
- Session Summary。
- Task Checkpoint。
- 記憶檢索。
- Context Budget。
- 相關脈絡選取。

**Phase 4：建立 Sensitive Data Guard**

- 敏感路徑防護。
- Secret Detection。
- Redaction。
- Outbound Payload Validation。
- 持久化安全檢查。

**Phase 5：整合 Agent 與 BrowserBridge**

- 本機脈絡組裝。
- 跨帳號恢復。
- 暫時性網頁對話。
- 帳號切換後使用既有 Session。

**Phase 6：整合 UI**

- Session 管理。
- Project Memory 檢視。
- Privacy Settings。
- 必要的錯誤與安全警告。

**Phase 7：測試與文件**

- Unit Tests。
- Integration Tests。
- 舊版相容性。
- README 更新。
- 安全性限制說明。

請直接修改程式碼，不要只輸出重構建議、Pseudocode 或部分範例。

如果某項需求受限於 NTPU AI 官方網站功能，應明確標記限制，不要使用未經確認的私有 API、規避驗證或安全限制。

---

# 十、最終交付要求

完成後請提供：

1. **架構變更摘要**：說明新的 Memory 與 Security 架構。
2. **修改檔案清單**：列出新增或修改的主要檔案與用途。
3. **實際完成的功能**：區分已實作、部分完成與尚未完成。
4. **資料遷移說明**：如何從舊 SessionStore 升級。
5. **安全防護說明**：哪些資料會阻擋、遮蔽或要求確認。
6. **測試結果**：列出執行的指令、通過項目與失敗項目。
7. **剩餘限制**：尤其是 Terminal/MCP 缺乏完整沙箱，以及 NTPU AI 遠端資料刪除的限制。
8. **使用方式**：使用者如何查看 Project Memory、管理 Session、控制隱私。
9. **後續擴充建議**：如何對接其他 Provider 或 Oh My OpenAgent。

請避免：

- 過度工程化。
- 引入不必要的大型依賴。
- 大幅破壞既有 UI。
- 未經驗證就宣稱測試成功。
- 將未完成的架構列為已完成。
- 以 Prompt 文字取代真正的 Host 安全機制。
- 在背景無限制呼叫模型產生記憶。
- 因自動摘要而消耗過多 NTPU AI 模型資源。

**最終目標：**

讓 NTPU AI Agent 成為具有持久化專案記憶、跨帳號接續能力、智慧上下文管理，以及實際敏感資料防護能力的 Local-first Coding Agent。

使用者可以長期使用同一台電腦進行開發，不必依賴任何特定 NTPU AI 網頁聊天紀錄，同時避免專案中的 API Keys、密碼、私人憑證及敏感資料在模型請求與工具執行過程中意外外洩。

請以可靠性、安全性、向下相容性及可維護性作為優先原則，完成實際程式修改與驗證。