/**
 * LINE -> Trello 開單機器人
 *
 * 流程：在 LINE 群組裡 @機器人 並寫下問題 -> 自動在 Trello「待確認」清單開一張卡
 *       -> 機器人回傳卡片連結。截圖由提出者自己到 Trello 卡片內補上。
 *
 * 所有金鑰放在「專案設定 > 指令碼屬性」，不要寫死在這個檔案裡。
 */

/* ========== 設定讀取 ========== */

function prop_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('缺少指令碼屬性: ' + key);
  return v;
}

/* ========== Webhook 進入點 ========== */

/** 版本標記：改程式後把這個數字加一，就能從執行紀錄看出部署的是不是新版 */
var CODE_VERSION = 'v22';

/**
 * 私訊開單的前綴。半形 # 與全形 ＃ 都接受 —— 中文輸入法下打出來的常是全形，
 * 只認半形的話使用者會覺得「明明有加 # 卻沒反應」。
 * 群組模式不強制前綴（@ 本身已經是明確的意圖），但有加也會被去掉。
 */
var PREFIX_RE = /^[#＃]\s*/;

/**
 * 執行軌跡。「執行項目」的 Cloud 記錄檔有時展不開（權限、GCP 專案設定等因素都可能），
 * 所以同一份訊息也累積在這裡，結束時寫進指令碼屬性，用 showLastTrace() 直接讀。
 */
var TRACE = [];

function trace_(msg) {
  var t = Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm:ss');
  TRACE.push(t + '  ' + msg);
  console.log(msg);
}

function saveTrace_() {
  try {
    PropertiesService.getScriptProperties()
      .setProperty('LAST_TRACE', TRACE.join('\n').slice(0, 8000));
  } catch (err) {
    console.warn('無法儲存 LAST_TRACE: ' + err);
  }
}

/**
 * 清掉快取。換過 LINE_CHANNEL_ACCESS_TOKEN 之後一定要跑一次 ——
 * bot 自己的 userId 會快取 6 小時，沒清的話群組裡的 @ 判定還在拿舊 bot 的 id 比對。
 */
function setupClearCache() {
  CacheService.getScriptCache().removeAll(['BOT_USER_ID', 'CODEX_AT']);
  console.log('已清除 BOT_USER_ID 與 CODEX_AT 快取。\n' +
    '新的 bot userId：' + (botUserId_() || '(查不到，檢查 LINE_CHANNEL_ACCESS_TOKEN)'));
}

/** 印出最後一次 doPost 的完整執行過程 */
function showLastTrace() {
  var raw = PropertiesService.getScriptProperties().getProperty('LAST_TRACE');
  console.log(raw
    ? '最後一次 doPost 的執行過程：\n\n' + raw
    : '還沒有紀錄。請先部署新版，再從 LINE 送一則訊息。');
}

function doPost(e) {
  TRACE = [];
  trace_('=== doPost 進入 (' + CODE_VERSION + ') ===');

  // 最優先：在做任何檢查之前先把收到的東西原樣存下來。
  // 存在密鑰檢查之後的話，被拒絕的請求不會留下痕跡，就查不出是誰擋的。
  var dump = {
    版本: CODE_VERSION,
    時間: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
    網址參數: (e && e.parameter) ? e.parameter : null,
    有無body: !!(e && e.postData && e.postData.contents),
    body: (e && e.postData && e.postData.contents)
            ? e.postData.contents.slice(0, 6000) : null
  };
  try {
    PropertiesService.getScriptProperties()
      .setProperty('LAST_EVENT', JSON.stringify(dump));
  } catch (err) {
    console.warn('無法儲存 LAST_EVENT: ' + err);
  }

  // Apps Script 的 doPost 讀不到 HTTP header，無法驗證 X-Line-Signature，
  // 改用寫在 webhook 網址上的密鑰 (?k=...) 當作最低限度的來源檢查。
  try {
    // 逃生門：把指令碼屬性 HOOK_SECRET 設成字串 off，就略過這道檢查。
    // /exec 網址本身已有 40 餘個隨機字元，猜中機率極低；最壞情況也只是被灌垃圾卡片。
    if (prop_('HOOK_SECRET') === 'off') {
      console.log('[略過] HOOK_SECRET=off，不檢查來源');
    } else if (!e || !e.parameter || e.parameter.k !== prop_('HOOK_SECRET')) {
      console.warn('[退出] 密鑰不符或缺少 ?k= 參數。收到的 k=' +
        (e && e.parameter ? JSON.stringify(e.parameter.k) : '(無)') +
        '　→ 檢查 LINE webhook 網址結尾是否為 ?k=<HOOK_SECRET>，且與指令碼屬性完全一致');
      return ContentService.createTextOutput('forbidden');
    }
  } catch (err) {
    console.error('[退出] 設定不完整: ' + err);
    return ContentService.createTextOutput('misconfigured');
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    console.warn('[退出] request body 不是合法 JSON');
    return ok_();
  }

  // payload 的 destination 是「這個事件要送給哪一個 bot」。
  // 它必須等於我們手上這把 token 所屬 bot 的 userId，否則就是
  // 「用 A channel 的 token 去處理 B channel 的事件」—— reply 會回
  // Invalid reply token，而且沒有任何地方會直接告訴你原因。
  if (body.destination) {
    var mine = botUserId_();
    if (mine && body.destination !== mine) {
      trace_('[channel 不符] 事件送給 ' + body.destination +
        '，但 LINE_CHANNEL_ACCESS_TOKEN 屬於 ' + mine +
        '\n→ 你有多個 channel 指向同一個 webhook 網址。' +
        '把用不到的那個 channel 的 Webhook URL 清空，' +
        '或改用正確 channel 的 access token。');
    } else if (mine) {
      trace_('[channel] 相符 ' + mine);
    }
  }

  var events = body.events || [];
  trace_('[收到] events 數量 = ' + events.length +
    (events.length === 0 ? '　→ 這是 LINE 的 Verify 驗證請求，不是真實訊息' : ''));
  for (var i = 0; i < events.length; i++) {
    try {
      handleEvent_(events[i]);
    } catch (err) {
      trace_('[例外] ' + err + (err && err.stack ? '\n' + err.stack : ''));
    }
  }
  saveTrace_();
  return ok_();
}

function ok_() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========== 事件處理 ========== */

/**
 * 目前正在處理的事件。reply_ 需要它來決定 push 的目標，
 * 但 reply_ 的呼叫點散在各處都只傳 replyToken，一一改簽章太動干戈。
 */
var CURRENT_EV = null;

function handleEvent_(ev) {
  CURRENT_EV = ev;

  trace_('[事件] type=' + ev.type +
    '　source=' + (ev.source ? ev.source.type : '?') +
    '　message=' + (ev.message ? ev.message.type : '-'));

  // 加好友、或被邀請進群組時，主動把使用說明送出去。
  // 使用者第一次接觸 bot 的時機就是最該告訴他怎麼用的時機。
  if (ev.type === 'follow') {
    reply_(ev.replyToken, '我是問題追蹤小幫手。\n\n' + helpText_());
    return;
  }

  // 被拉進新群組：先提醒綁定看板，否則這個群組的卡片會開到預設看板上
  if (ev.type === 'join') {
    reply_(ev.replyToken,
      '我是問題追蹤小幫手。\n\n' +
      '這個群組還沒綁定看板，目前會用預設看板。\n' +
      '要讓這個群組用自己的看板，請管理員執行：\n' +
      '@@@/setup https://trello.com/b/看板網址\n\n' +
      '用法說明：@@@/help');
    return;
  }

  if (ev.type !== 'message' || !ev.message) {
    trace_('[退出] 不是訊息事件，忽略');
    return;
  }

  // LINE 收不到 200 時會重送，用 webhookEventId 去重，避免開出重複卡片
  if (ev.webhookEventId) {
    var cache = CacheService.getScriptCache();
    var k = 'ev_' + ev.webhookEventId;
    if (cache.get(k)) return;
    cache.put(k, '1', 600);
  }

  // 圖片：附到「這個人」最近操作的那張卡。
  // 私訊 30 分鐘內有效；群組只收 5 分鐘內，且不符合時安靜略過 ——
  // 群組裡跟卡片無關的照片很多，回話會洗版。
  if (ev.message.type === 'image') {
    attachImage_(ev);
    return;
  }

  if (ev.message.type !== 'text') {
    trace_('[退出] 不是文字訊息，忽略');
    return;
  }

  // LINE 限制：一個群組只能有一個官方帳號。若目標群組的名額已被別的 bot 佔走，
  // 就改用 1 對 1 私訊開單。兩種來源都支援：
  //   - 群組／多人聊天室：必須 @ 到本 bot 才觸發，避免把閒聊全開成卡片
  //   - 1 對 1 私訊：整段訊息就是問題，不需要 @
  var isDirect = (ev.source && ev.source.type === 'user');
  var text;

  // 取出「這則訊息真正要交給 bot 處理的內容」。
  // 私訊就是原文；群組要先確認有呼叫 bot，並把呼叫記號剝掉。
  var payload;
  if (isDirect) {
    payload = (ev.message.text || '').trim();
  } else {
    payload = groupPayload_(ev);
    if (payload === null) {
      trace_('[退出] 群組訊息沒有呼叫 bot（開頭不是 @@@，也沒有 @到我）');
      return;
    }
    if (!payload) {
      reply_(ev.replyToken, '@@@ 後面要接內容，例如：\n@@@報表匯出會缺最後一列\n@@@/list');
      return;
    }
  }

  if (!payload) return;

  // ── 指令層 ──
  if (payload.charAt(0) === '/') {
    handleCommand_(payload, ev);
    return;
  }

  if (isDirect) {
    text = payload;

    if (!PREFIX_RE.test(text)) {
      // 不是開單、也不是指令 —— 交給 LLM 判斷意圖（沒設定的話會回傳 null）
      if (llmHandle_(text, ev)) return;

      trace_('[退出] 私訊未以 # 開頭，不開單');
      reply_(ev.replyToken,
        '要開單請用 # 開頭，例如：\n#報表匯出會缺最後一列\n\n' +
        '其他可用指令：\n/list 看未結案\n/done <編號或關鍵字> 結案\n/help 說明');
      return;
    }

    text = text.replace(PREFIX_RE, '').trim();
    if (!text) {
      reply_(ev.replyToken, '# 後面要接問題內容，例如：\n#報表匯出會缺最後一列');
      return;
    }
  } else {
    // 群組已經用 @@@ 或 @提及 表達過意圖了，不再強制 # 前綴；有加就順手去掉
    text = payload.replace(PREFIX_RE, '').trim();
    if (!text) {
      reply_(ev.replyToken, '後面要接問題內容，例如：\n@@@報表匯出會缺最後一列');
      return;
    }
  }

  var who = senderName_(ev);
  var when = Utilities.formatDate(new Date(ev.timestamp), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');

  var title = text.split('\n')[0];
  if (title.length > 60) title = title.slice(0, 60) + '...';

  var desc = [
    text,
    '',
    '---',
    '提出者: ' + who,
    '提出時間: ' + when + (isDirect ? ' (LINE 私訊)' : ' (LINE 群組)')
  ].join('\n');

  trace_('[開單] ' + title);
  var card = createCard_(title, desc);
  trace_('[成功] ' + card.shortUrl);

  // 記住這張卡，接下來 30 分鐘內傳的圖片會自動附上去
  rememberCard_(ev, { id: card.id, idShort: card.idShort, name: title, url: card.shortUrl });

  reply_(ev.replyToken, [
    '已開單 ' + card.idShort + '. ' + title,
    card.shortUrl,
    '',
    '接著可以直接傳圖片附上去，或用',
    '/note ' + card.idShort + ' 內容　留言',
    '/take ' + card.idShort + '　　　認領'
  ].join('\n'));
}

/* ========== 判斷群組訊息是否在呼叫本 bot ========== */

/**
 * 群組裡的呼叫記號，必須在訊息開頭。半形 @ 與全形 ＠ 都接受。
 *
 * 為什麼需要它：LINE 電腦版的 @ 候選清單不會列出官方帳號，所以電腦版的人
 * 根本沒辦法 @ bot（手打名字不算，mention 資料是客戶端產生的）。
 * @@@ 等價於 @bot，兩種寫法效果完全相同。
 */
var GROUP_TRIGGER_RE = /^[@＠]{3}\s*/;

/**
 * 回傳群組訊息中要交給 bot 的內容。
 *   null  —— 沒有在呼叫 bot，整則忽略
 *   ''    —— 有呼叫但後面沒東西
 *   其他  —— 剝掉呼叫記號後的內容
 */
function groupPayload_(ev) {
  var raw = (ev.message.text || '').trim();

  if (GROUP_TRIGGER_RE.test(raw)) {
    trace_('[群組] 以 @@@ 呼叫');
    return raw.replace(GROUP_TRIGGER_RE, '').trim();
  }

  var mention = ev.message.mention;
  if (mention && mention.mentionees && mention.mentionees.length &&
      mentionsBot_(mention.mentionees)) {
    trace_('[群組] 以 @提及 呼叫');
    return stripMentions_(ev.message.text, mention.mentionees).trim();
  }

  return null;
}

function mentionsBot_(mentionees) {
  for (var i = 0; i < mentionees.length; i++) {
    if (mentionees[i].isSelf === true) return true;
  }
  // 舊版事件沒有 isSelf，退回比對 userId
  var self = botUserId_();
  if (!self) return false;
  for (var j = 0; j < mentionees.length; j++) {
    if (mentionees[j].userId && mentionees[j].userId === self) return true;
  }
  return false;
}

function botUserId_() {
  var cache = CacheService.getScriptCache();
  var id = cache.get('BOT_USER_ID');
  if (id) return id;

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return '';
  id = JSON.parse(res.getContentText()).userId || '';
  if (id) cache.put('BOT_USER_ID', id, 21600);
  return id;
}

/**
 * 把 @提及 的文字從訊息中拿掉。
 * mentionee 的 index / length 是 UTF-16 碼元位置，與 JS 字串索引一致。
 * 必須由後往前刪，否則索引會位移。
 */
function stripMentions_(text, mentionees) {
  var sorted = mentionees.slice().sort(function (a, b) { return b.index - a.index; });
  var out = text;
  for (var i = 0; i < sorted.length; i++) {
    var m = sorted[i];
    if (typeof m.index !== 'number' || typeof m.length !== 'number') continue;
    out = out.slice(0, m.index) + out.slice(m.index + m.length);
  }
  return out.trim();
}

/* ========== 取得發話者名稱 ========== */

function senderName_(ev) {
  var src = ev.source || {};
  if (!src.userId) return '未知成員';

  var url;
  if (src.type === 'group') {
    url = 'https://api.line.me/v2/bot/group/' + src.groupId + '/member/' + src.userId;
  } else if (src.type === 'room') {
    url = 'https://api.line.me/v2/bot/room/' + src.roomId + '/member/' + src.userId;
  } else {
    url = 'https://api.line.me/v2/bot/profile/' + src.userId;
  }

  try {
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return '未知成員';
    return JSON.parse(res.getContentText()).displayName || '未知成員';
  } catch (err) {
    return '未知成員';
  }
}

/* ========== Trello ========== */

/** 目前專案的「待確認」清單 id。群組綁了看板就用那個，否則用預設看板。 */
function todoListOrThrow_() {
  var id = lists_().todo;
  if (!id) throw new Error('目前專案沒有設定「待確認」清單（預設看板要設 TRELLO_LIST_ID，群組要先 /setup）');
  return id;
}

function createCard_(name, desc) {
  var res = UrlFetchApp.fetch('https://api.trello.com/1/cards', {
    method: 'post',
    payload: {
      key: prop_('TRELLO_KEY'),
      token: prop_('TRELLO_TOKEN'),
      idList: todoListOrThrow_(),
      name: name,
      desc: desc,
      pos: 'top'
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Trello 建卡失敗 ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

/* ========== LINE 回覆 ========== */

/**
 * 回覆使用者。
 *
 * reply API 失敗時自動改用 push。最常見的失敗是 replyToken 已被消耗
 * （官方帳號後台的「自動回應訊息」沒關，LINE 會先用掉 token），
 * 這種情況 reply 一律回 400，而且原本完全沒有記錄，只會表現成「bot 都不回話」。
 *
 * reply 是免費且不限次數的，push 會吃掉免費方案的月額度，所以只在 reply 失敗時才用。
 */
function reply_(replyToken, text) {
  if (text === undefined || text === null || text === '') return;
  var auth = { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') };
  var messages = [{ type: 'text', text: String(text) }];

  if (replyToken) {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      contentType: 'application/json',
      headers: auth,
      payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) { trace_('[回覆] reply 送出成功'); return; }

    trace_('[回覆失敗] reply API 回 ' + res.getResponseCode() + ': ' +
      res.getContentText() +
      '\n→ 常見原因：官方帳號後台「回應設定 > 自動回應訊息」沒有關閉。改用 push 重送。');
  }

  var to = pushTarget_();
  if (!to) {
    trace_('[回覆失敗] 也找不到 push 的目標，這則訊息送不出去。');
    return;
  }

  var p = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: auth,
    payload: JSON.stringify({ to: to, messages: messages }),
    muteHttpExceptions: true
  });
  if (p.getResponseCode() === 200) trace_('[回覆] 已改用 push 送出');
  else trace_('[回覆失敗] push 也失敗 ' + p.getResponseCode() + ': ' + p.getContentText());
}

/** push 的目標 id。群組送群組，私訊送個人。 */
function pushTarget_() {
  var src = CURRENT_EV && CURRENT_EV.source;
  if (!src) return null;
  return src.groupId || src.roomId || src.userId || null;
}

/* ========== 設定用的輔助函式（在編輯器裡手動執行） ========== */

/**
 * 列出看板上所有清單的 ID，用來填 TRELLO_LIST_ID。
 * 先設好 TRELLO_KEY / TRELLO_TOKEN / TRELLO_BOARD_URL 三個指令碼屬性，
 * TRELLO_BOARD_URL 直接貼看板網址即可，例如 https://trello.com/b/aBcD1234/xxx
 */
function setupListBoardLists() {
  var boardUrl = prop_('TRELLO_BOARD_URL');
  var m = boardUrl.match(/trello\.com\/b\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('TRELLO_BOARD_URL 格式不對，應該像 https://trello.com/b/aBcD1234/board-name');

  var auth = 'key=' + prop_('TRELLO_KEY') + '&token=' + prop_('TRELLO_TOKEN');
  var res = UrlFetchApp.fetch(
    'https://api.trello.com/1/boards/' + m[1] + '/lists?fields=id,name&' + auth,
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() >= 300) {
    throw new Error('讀取清單失敗 ' + res.getResponseCode() + ': ' + res.getContentText());
  }

  var lists = JSON.parse(res.getContentText());
  var out = ['看板清單如下，把要收單的那個 id 填進 TRELLO_LIST_ID：'];
  for (var i = 0; i < lists.length; i++) {
    out.push('  ' + lists[i].name + '  ->  ' + lists[i].id);
  }
  console.log(out.join('\n'));
}

/** 產生一組隨機字串當 HOOK_SECRET */
function setupGenerateHookSecret() {
  var s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  console.log('HOOK_SECRET 建議值：' + s.slice(0, 40));
}

/**
 * 印出要接在部署網址後面的密鑰參數。
 *
 * 注意：不要用 ScriptApp.getService().getUrl() 自動組網址。那個回傳的是
 * 「頭部部署」(/dev) 的網址，部署 ID 跟你實際發布的版本不同，而且 /dev
 * 一律要求登入，LINE 匿名呼叫會拿到 401。
 *
 * 正確做法：從「部署 → 管理部署作業」複製那條 /exec 網址，接上這裡印出的參數。
 */
function setupShowWebhookUrl() {
  console.log(
    '1. 從「部署 → 管理部署作業」複製「網頁應用程式」那條 /exec 網址\n' +
    '2. 後面直接接上這一段：\n\n' +
    '   ?k=' + prop_('HOOK_SECRET') + '\n\n' +
    '3. 合起來像這樣：\n' +
    '   https://script.google.com/macros/s/<你的部署ID>/exec?k=' + prop_('HOOK_SECRET')
  );
}

/**
 * 驗證 LINE_CHANNEL_ACCESS_TOKEN 是否有效，並印出 bot 的 userId。
 * mentionsBot_ 在 mention 物件沒有 isSelf 時會退回比對這個 id，
 * 所以 token 壞掉的話，群組 @ 會靜默失效（沒有錯誤，就是不開單）。
 */
function testLineToken() {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    console.error('LINE token 無效（HTTP ' + code + '）：' + res.getContentText() +
      '\n→ 回 LINE Developers Console 的 Messaging API 分頁重新發行 ' +
      'Channel access token (long-lived)，再更新指令碼屬性。');
    return;
  }
  var info = JSON.parse(res.getContentText());
  console.log('LINE token 正常。\n  bot 名稱: ' + info.displayName +
    '\n  basicId: ' + info.basicId + '\n  userId: ' + info.userId);
}

/**
 * 印出 LINE 最後一次送來的原始 payload，並自動診斷卡在哪一關。
 * 先在 LINE 發一則訊息，再回編輯器執行這個函式。
 */
function showLastEvent() {
  var raw = PropertiesService.getScriptProperties().getProperty('LAST_EVENT');
  if (!raw) {
    console.log('沒有紀錄。代表 LINE 的請求從來沒進到腳本裡：\n' +
      '  - webhook 網址錯了（要用「管理部署作業」裡那條 /exec，不是 /dev）\n' +
      '  - 或 LINE Developers Console 的 Use webhook 沒開啟\n' +
      '  - 或部署的還是舊版程式（doPost 開頭應該印出 ' + CODE_VERSION + '）');
    return;
  }

  var dump;
  try {
    dump = JSON.parse(raw);
  } catch (err) {
    console.log('紀錄格式不正確（可能是舊版寫入的）。請重新部署後再測一次。\n' + raw);
    return;
  }

  console.log('收到時間: ' + dump.時間 + '　執行的程式版本: ' + dump.版本);
  console.log('網址參數: ' + JSON.stringify(dump.網址參數));

  // 密鑰是否相符 —— 這是最常見的靜默失敗原因
  var expected = PropertiesService.getScriptProperties().getProperty('HOOK_SECRET');
  var got = dump.網址參數 ? dump.網址參數.k : undefined;
  if (!expected) {
    console.log('診斷：指令碼屬性 HOOK_SECRET 不存在。');
    return;
  }
  if (got !== expected) {
    console.log('診斷：密鑰不符，請求在第一關就被擋掉。\n' +
      '  webhook 網址帶來的 k = ' + JSON.stringify(got) + '\n' +
      '  指令碼屬性的 HOOK_SECRET = ' + JSON.stringify(expected) + '\n' +
      '  → 把 LINE 的 Webhook URL 改成 <你的/exec網址>?k=' + expected);
    return;
  }
  console.log('密鑰檢查: 通過');

  if (!dump.body) {
    console.log('診斷：這個請求沒有 body，不是 LINE 的 webhook 呼叫。');
    return;
  }
  console.log('原始 payload：\n' + dump.body + '\n');

  var body;
  try {
    body = JSON.parse(dump.body);
  } catch (err) {
    console.log('payload 不是合法 JSON');
    return;
  }

  var events = body.events || [];
  if (!events.length) {
    console.log('診斷：events 是空的 → 這是 LINE 的 Verify 驗證請求，不是真實訊息。');
    return;
  }

  events.forEach(function (ev, i) {
    console.log('--- event[' + i + '] ---');
    console.log('  type=' + ev.type + '  source=' + (ev.source ? ev.source.type : '?') +
      '  message=' + (ev.message ? ev.message.type : '-'));

    if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') {
      console.log('  診斷：不是文字訊息，程式會略過。');
      return;
    }
    console.log('  文字內容: ' + JSON.stringify(ev.message.text));

    var body2 = (ev.message.text || '').trim();

    if (body2.charAt(0) === '/') {
      console.log('  診斷：這是指令，會走 handleCommand_（Commands.gs），不會開卡。\n' +
        '        若實際卻建了卡片，代表當時跑的是還沒有指令層的舊版程式。');
      return;
    }

    if (ev.source && ev.source.type === 'user') {
      console.log(PREFIX_RE.test(body2)
        ? '  診斷：私訊且有 # 前綴，應該要開單成功。'
        : '  診斷：私訊但沒有 # 前綴 → 交給 LLM 判讀；判不出來就只回提示，不開卡。');
      return;
    }

    var mention = ev.message.mention;
    if (!mention || !mention.mentionees || !mention.mentionees.length) {
      console.log('  診斷：群組訊息但 payload 裡沒有 mention 物件。\n' +
        '        → @ 是手打的，不算數。必須從 LINE 跳出的候選清單「點選」機器人，\n' +
        '          被選中的名字會以特殊樣式顯示，這樣才會帶 mention 資料。');
      return;
    }

    console.log('  mentionees: ' + JSON.stringify(mention.mentionees));
    var self = botUserId_();
    console.log('  本 bot 的 userId: ' + (self || '(查不到，LINE token 可能有問題)'));

    var hit = mention.mentionees.some(function (m) {
      return m.isSelf === true || (m.userId && m.userId === self);
    });
    console.log(hit ? '  診斷：有 @ 到本 bot，應該要開單成功。'
                    : '  診斷：@ 到的不是本 bot，程式會略過。');
  });
}

/** 不經過 LINE，直接測試 Trello 建卡是否正常 */
function testCreateCard() {
  var card = createCard_('測試卡片（可刪除）', '這是由 GAS 測試建立的卡片。');
  console.log('建立成功: ' + card.shortUrl);
}
