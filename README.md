# LINE → Trello 問題追蹤機器人

**LINE 是操作介面，Trello 只是資料的家。** 整個卡片生命週期都能在 LINE 裡完成，
使用者不需要打開 Trello 網頁。

| 做什麼 | 怎麼做 |
|---|---|
| 開單 | 私訊 `#問題描述`，或群組 `@@@問題描述` |
| 補截圖 | 開完單直接傳圖片，自動附到那張卡（30 分鐘內有效） |
| 看清單 | `/list` |
| 看內容與留言 | `/show 12` |
| 認領 | `/take 12` |
| 等回覆 | `/wait 12` |
| 結案 | `/done 12`，或 `/done 報表`（關鍵字） |
| 留言討論 | `/note 12 內容` |
| 改標題 | `/rename 12 新標題` |
| 設期限 | `/due 12 8/25`、`/due 12 clear` |
| 綁定帳號 | `/bind 你的Trello使用者名稱`（認領時才標記得到人） |
| 自然語言 | 「報表那個處理好了可以關掉」（需啟用 LLM 層） |

## 架構

```
LINE 群組  --@機器人-->  LINE Messaging API
                              |  webhook (POST)
                              v
                    Google Apps Script (doPost)
                              |  Trello REST API
                              v
                   Trello 看板「待確認」清單
                              |
                    回傳卡片連結到 LINE 群組
```

---

## 一、Trello 準備

看板已經建好（透過 Trello connector 建立）：

- **問題追蹤｜地端 LLM 專案** — <https://trello.com/b/bfou7zRV/>
  - 可見性：**Private**
  - 清單：待確認 / 處理中 / 等回覆 / 已解決
  - 「待確認」清單 id：`6a87b8827726aceeaa0fbdc3`（填進 `TRELLO_LIST_ID`）
  - 已放一張「使用規則」卡，團隊看完可封存

另有一個 **地端 LLM 系統｜證交好夥伴** 規劃板，用途不同（提案與架構規劃），
兩個板子不要混用。

剩下要做的：

1. 用 Email 或連結邀請 7 位成員（各自用 Google 登入）
2. 取得 API 金鑰
   - 前往 <https://trello.com/power-ups/admin>
   - 建立一個 Power-Up（名稱隨意，例如 `line-bot`），建立後即可看到 **API Key**
   - 在同一頁點「Token」產生使用者 token，或自行開啟：

     ```
     https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=line-bot&key=你的APIKey
     ```

   - 授權後畫面顯示的字串就是 **Token**

> Token 等同於你的 Trello 帳號權限，不要外流、不要進版控。

---

## 二、建立 Apps Script 專案

1. 開啟 <https://script.google.com> → 新增專案
2. 把 `Code.gs` 的內容整份貼進去，存檔
3. 左側「專案設定」→ 勾選「在編輯器中顯示 `appsscript.json`」（可選）
4. 「專案設定」→ **指令碼屬性**，新增以下項目：

| 屬性名稱 | 值 |
|---|---|
| `TRELLO_KEY` | 上一步的 API Key |
| `TRELLO_TOKEN` | 上一步的 Token |
| `TRELLO_BOARD_URL` | `https://trello.com/b/bfou7zRV/問題追蹤地端-llm-專案` |
| `TRELLO_LIST_ID` | `6a87b8827726aceeaa0fbdc3`（「待確認」清單，已建好） |
| `LINE_CHANNEL_ACCESS_TOKEN` | 第三節取得 |
| `HOOK_SECRET` | 執行 `setupGenerateHookSecret` 產生 |

5. `TRELLO_LIST_ID` 已經在上表給你了。若之後改了看板結構，可執行 `setupListBoardLists` 重新查
6. 執行 `testCreateCard` 確認 Trello 端沒問題（會開一張測試卡，測完自己刪掉）

---

## 三、建立 LINE Bot

1. <https://developers.line.biz/console/> → 建立 Provider → 建立 **Messaging API** channel
2. 「Messaging API」分頁 → 發行 **Channel access token (long-lived)** → 填進 `LINE_CHANNEL_ACCESS_TOKEN`
3. 到 [LINE Official Account Manager](https://manager.line.biz/) → 該帳號 → **設定 → 回應設定**：
   - 「聊天」：**開啟**
   - 「自動回應訊息」：**關閉**（不關的話機器人會多回一則罐頭訊息）
   - 「Webhook」：**開啟**
4. 「設定 → 帳號設定」→ 允許被邀請加入群組：**開啟**

---

## 四、部署並串接

1. Apps Script 右上「部署 → 新增部署作業」
   - 類型：**網頁應用程式**
   - 執行身分：**我**
   - 存取權：**任何人**（LINE 伺服器是匿名呼叫，必須設成這個）
2. 複製 `/exec` 結尾的網址，後面接上密鑰：

   ```
   https://script.google.com/macros/s/AKfyc.../exec?k=你的HOOK_SECRET
   ```

3. 回到 LINE Developers Console →「Messaging API」→ **Webhook URL** 填上面那串 → **Use webhook 開啟**
4. 把機器人加進 LINE 群組，測試：

   ```
   @小幫手 報表匯出會缺最後一列
   ```

---

## 已知的坑

| 現象 | 說明 |
|---|---|
| Verify 回 **302** | 正常，可忽略。Apps Script 的 `/exec` 會把回應導向 googleusercontent，LINE 不跟隨轉址所以判定失敗，但腳本其實已經執行了。以真實訊息測試為準。 |
| Verify 回 **401** | 真的有問題。部署設定的「具有存取權的使用者」不是「所有人」，或你填的是 `/dev` 網址。`/dev`（頭部部署）一律要求登入，LINE 匿名呼叫必定 401 —— 一定要用「管理部署作業」裡那條 `/exec`。 |
| 無法驗證 `X-Line-Signature` | Apps Script 的 `doPost(e)` 讀不到 HTTP header，這是平台限制。改用網址上的 `?k=` 密鑰做來源檢查。若 LINE 不接受帶 query string 的 webhook URL，就拿掉並依賴 `/exec` 網址本身的隨機性。 |
| 開出重複卡片 | LINE 在收不到 200 時會重送。程式用 `webhookEventId` + `CacheService` 去重（保留 10 分鐘）。 |
| 改了程式沒生效 | Apps Script 必須重新「部署 → 管理部署作業 → 編輯 → 版本改為新版本」，存檔不等於部署。 |
| 群組傳圖沒反應 | 圖片只在私訊處理。群組裡大家傳的圖多半跟卡片無關，全附上去會很吵。 |
| 傳圖回「還沒有指定卡片」 | 要先開單或 `/show 編號` 指定目標，之後 30 分鐘內傳的圖才有歸屬。 |
| bot 邀請不進群組，卡在待處理 | **一個 LINE 群組只能有一個官方帳號**（平台硬限制）。該群組已有別的 bot 佔走名額。移除舊的、另開群組，或改用 1 對 1 私訊開單。 |

## 怎麼叫出 bot

| 場合 | 觸發方式 |
|---|---|
| 私訊 | 開單用 `#` 或 `＃` 開頭；指令用 `/` 開頭 |
| 群組 | 訊息**開頭**打 `@@@`（或 `＠＠＠`），等價於 @bot |

`@@@` 存在的理由：**LINE 電腦版的 @ 候選清單不會列出官方帳號**，電腦版的人
根本 @ 不到 bot，手打名字也不算（mention 資料是客戶端產生的）。
真正的 @提及 照樣有效，兩種寫法走同一條路。

規則寫在 `GROUP_TRIGGER_RE` 與 `PREFIX_RE`，要換符號改那兩行。

## 訊息怎麼分流

判斷完全看**開頭**，不猜語意，所以不會誤判。

**私訊**

| 訊息長相 | 走哪一層 | 結果 |
|---|---|---|
| `/` 開頭 | 指令層 | `/list`、`/done 12`、`/help` |
| `#` 或 `＃` 開頭 | 開單 | 建立卡片 |
| 圖片 | 附件 | 附到最近操作的那張卡 |
| 招呼語或少於 3 個字 | 直接擋掉 | 回提示，不呼叫 LLM |
| 其他任何文字 | **LLM 判讀意圖** | 看不懂就回提示 |

**群組**

| 訊息長相 | 走哪一層 |
|---|---|
| `@@@/done 12` 或 `@bot /done 12` | 指令層 |
| `@@@問題描述` 或 `@bot 問題描述` | 開單（群組不強制 `#`） |
| 沒有 `@@@` 也沒 @到 bot | **完全忽略**，不呼叫 LLM |
| 圖片 | 忽略 |

群組刻意不接 LLM —— 不然整串閒聊都會被送去判讀，既花配額也容易誤動卡片。

## LLM 層（選用）

指令層不需要 LLM 就能完整運作。LLM 只在「私訊 + 非指令 + 非開單」時被呼叫，
用來解讀像「報表那個處理好了可以關掉」這種自由語句。

沒設定 `OPENAI_REFRESH_TOKEN` 就等於停用，其餘功能不受影響。

設定方式與已知風險見 `Llm.gs` 檔頭。重點：

- 授權在 PC 上用 my-agent 做一次，把 `refresh_token` 搬進指令碼屬性
- 模型**只負責選出動作與卡號**，實際操作仍走 `Commands.gs` 的確定性程式碼
- `create` 意圖不會自動建卡，會先回一則確認訊息
- codex 後端未公開，壞掉時 `llmHandle_` 回 false，自動退回指令層提示

| 屬性 | 說明 |
|---|---|
| `OPENAI_REFRESH_TOKEN` | 從 `~/.my-agent/token.json` 取出 |
| `OPENAI_CLIENT_ID` | 與取得該 token 時相同 |
| `OPENAI_MODEL` | 選填，預設 `gpt-5.6-terra`（用 `testLlmModels` 查可用 slug） |
| `OPENAI_ORIGINATOR` | 選填，預設 `my-agent` |

驗證函式：`testLlmToken`（換 token）、`testLlmRaw`（看原始回應）、`testLlmIntent`（試判讀）。

## 清單 ID 屬性

指令層要移動卡片，所以四個清單都要設：

| 屬性 | 清單 | 值 |
|---|---|---|
| `TRELLO_LIST_ID` | 待確認 | `6a87b8827726aceeaa0fbdc3` |
| `TRELLO_LIST_DOING` | 處理中 | `6a87b883198c633864ca4f62` |
| `TRELLO_LIST_WAITING` | 等回覆 | `6a87b8859670ed825e3ec064` |
| `TRELLO_LIST_DONE` | 已解決 | `6a87b8873aefca569853675b` |

## 公司網路

GAS 跑在 Google 的伺服器上，呼叫 Trello API 不經過公司 proxy，**不受 TLS 攔截影響**。
只有你在本機用 curl / Python 直接測 Trello API 時才需要那些繞法參數。

---

## 複製一套給另一個專案

程式碼完全不用改。所有環境相依的值都在指令碼屬性裡，複製 = 貼同一份程式碼 + 填不同的屬性。

### 一、複製 Apps Script 專案

**做法 A（推薦）** 直接新建一個空專案，把三個檔案貼進去：

1. <https://script.google.com> → 新增專案，命名例如 `line-trello-bot-專案B`
2. 左側 `+` → 指令碼，建立 `Commands`、`Llm`
3. 三個檔案內容各自貼上

**做法 B** 從 script.google.com 的專案清單，該專案右側 `⋮` → 建立副本。

> 兩種做法都**不會**帶走指令碼屬性。這是好事 —— 避免新 bot 誤用舊看板的設定，
> 但也表示下一步不能跳過。

### 二、準備新的 Trello 看板

1. 建看板，四個清單：待確認 / 處理中 / 等回覆 / 已解決
2. 在新專案的指令碼屬性先填 `TRELLO_KEY`、`TRELLO_TOKEN`、`TRELLO_BOARD_URL`
   （金鑰可以沿用同一組 —— 只要新看板也在同一個 Trello 帳號底下）
3. 執行 `setupListBoardLists`，把四個清單 id 填進對應屬性

### 三、準備新的 LINE Channel

**一定要開新的 channel。** 兩個 bot 不能共用一個 Messaging API channel。

1. LINE Developers Console → 新增 Messaging API channel
2. 發行 Channel access token (long-lived)
3. LINE Official Account Manager → 回應設定：
   - 回應模式：**聊天機器人**
   - **自動回應訊息：關閉** ← 不關會吃掉 replyToken，bot 變成完全不回話
   - Webhook：開啟
4. 帳號設定 → 允許被加入群組：開啟

### 四、填屬性

| 屬性 | 新專案要換嗎 |
|---|---|
| `TRELLO_KEY` | 可沿用 |
| `TRELLO_TOKEN` | 可沿用 |
| `TRELLO_LIST_ID` / `_DOING` / `_WAITING` / `_DONE` | **必換**，新看板的 |
| `LINE_CHANNEL_ACCESS_TOKEN` | **必換**，新 channel 的 |
| `HOOK_SECRET` | **必換**，跑 `setupGenerateHookSecret` 產生新的 |
| `OPENAI_REFRESH_TOKEN` / `OPENAI_CLIENT_ID` | 要用 `/ask` 才需要 |

`HOOK_SECRET` 不要兩個專案共用 —— 一邊外流會連累另一邊。

### 五、部署並串接

1. 部署 → 新增部署作業 → 網頁應用程式 / 執行身分：我 / 存取權：**所有人**
2. 複製新的 `/exec` 網址，接上 `?k=<新的HOOK_SECRET>`
3. 填進**新 channel** 的 Webhook URL，開啟 Use webhook

### 六、驗收

```
testCreateCard      → Trello 端通不通
testLineToken       → basicId 是不是新 bot
setupClearCache     → 清掉舊的 BOT_USER_ID 快取
```

然後私訊新 bot `/help`，再跑 `showLastTrace` 確認 `[回覆] reply 送出成功`。

### 最容易踩的三個坑

| 坑 | 症狀 |
|---|---|
| 新 channel 的自動回應訊息沒關 | bot 完全不回話，reply 回 400 Invalid reply token |
| 兩個 channel 指向同一個 webhook 網址 | trace 出現 `[channel 不符]` |
| 忘了換 `TRELLO_LIST_*` | 新 bot 把卡片開到舊看板上 |

第三個最危險 —— 它不會報錯，只是安靜地寫錯地方。部署後先開一張測試卡，
**親眼確認它出現在新看板上**再交給同事用。
