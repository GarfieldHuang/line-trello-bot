/**
 * LLM fallback —— 只在指令層看不懂訊息時才會被呼叫。
 *
 * 走 ChatGPT 訂閱配額（OAuth PKCE + codex 後端），與 my-agent 的 agent/auth.py 同一條路。
 * GAS 沒辦法跑互動式 PKCE（沒有 localhost 可以接 redirect，也沒有人在旁邊按授權），
 * 所以授權在你的 PC 上做一次，這裡只負責「用 refresh token 換 access token」。
 *
 * ── 設定 ──
 *   OPENAI_REFRESH_TOKEN  從 ~/.my-agent/token.json 或 Windows 認證管理員取出
 *   OPENAI_CLIENT_ID      與取得該 token 時用的 client_id 相同
 *   OPENAI_MODEL          選填，預設 gpt-5.4
 *   OPENAI_ORIGINATOR     選填，預設 my-agent（要跟當初授權時一致）
 *
 * 沒設定 OPENAI_REFRESH_TOKEN 就等於停用，llmHandle_ 一律回 false。
 *
 * ── 已知風險 ──
 * codex 後端是未公開端點，沒有相容性承諾；refresh token 綁在你的個人席次上。
 * 如果哪天整段壞掉，指令層仍可獨立運作，不會影響開單。
 */

/** 預設模型。指令碼屬性 OPENAI_MODEL 若有設定會覆蓋這裡。 */
var DEFAULT_MODEL = 'gpt-5.6-terra';

var CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
var TOKEN_URL  = 'https://auth.openai.com/oauth/token';

function llmProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v || fallback;
}

function llmEnabled_() {
  return !!llmProp_('OPENAI_REFRESH_TOKEN', '');
}

/* ========== Token ========== */

function codexAccessToken_() {
  var cache = CacheService.getScriptCache();
  var P = PropertiesService.getScriptProperties();

  // 1. 快取（GAS 上限 6 小時）
  var hit = cache.get('CODEX_AT');
  if (hit) return hit;

  // 2. 屬性裡還沒過期的 access token。
  //    access token 有效期長達數天，但 GAS 快取最多只能放 6 小時，
  //    只靠快取的話每 6 小時就會 refresh 一次 —— OpenAI 有 earliest_refresh_at
  //    的最短間隔限制，refresh 太頻繁會被拒。所以另外存一份在屬性裡。
  var saved   = P.getProperty('OPENAI_ACCESS_TOKEN');
  var savedAt = parseFloat(P.getProperty('OPENAI_ACCESS_EXPIRES_AT') || '0');
  if (saved && savedAt > (new Date().getTime() / 1000) + 300) {
    cache.put('CODEX_AT', saved, 21600);
    return saved;
  }

  var res = UrlFetchApp.fetch(TOKEN_URL, {
    method: 'post',
    payload: {
      grant_type:    'refresh_token',
      client_id:     llmProp_('OPENAI_CLIENT_ID', ''),
      refresh_token: llmProp_('OPENAI_REFRESH_TOKEN', '')
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 300) {
    throw new Error('刷新 access token 失敗 ' + res.getResponseCode() + ': ' +
      res.getContentText() + '\n→ refresh token 可能已失效，請在 PC 上重新登入 my-agent 後更新屬性。');
  }

  var tok = JSON.parse(res.getContentText());

  // OpenAI 會輪替 refresh token。回傳新的就必須存回去，否則下次刷不動。
  // 注意：輪替後，PC 上 my-agent 手上那份舊的可能同時失效 —— 見 README。
  if (tok.refresh_token) P.setProperty('OPENAI_REFRESH_TOKEN', tok.refresh_token);

  var expiresAt = (new Date().getTime() / 1000) + (tok.expires_in || 3600);
  P.setProperty('OPENAI_ACCESS_TOKEN', tok.access_token);
  P.setProperty('OPENAI_ACCESS_EXPIRES_AT', String(expiresAt));

  cache.put('CODEX_AT', tok.access_token, 21600);
  console.log('[LLM] 已換發 access token，到期 ' +
    Utilities.formatDate(new Date(expiresAt * 1000), 'Asia/Taipei', 'yyyy-MM-dd HH:mm'));
  return tok.access_token;
}

/** 從 JWT payload 取 chatgpt_account_id（不驗簽，只讀內容） */
function codexAccountId_(accessToken) {
  try {
    var part = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (part.length % 4) part += '=';
    var payload = JSON.parse(Utilities.newBlob(Utilities.base64Decode(part)).getDataAsString());
    var auth = payload['https://api.openai.com/auth'] || {};
    return auth.chatgpt_account_id || '';
  } catch (err) {
    return '';
  }
}

/* ========== 呼叫 ========== */

function llmAsk_(instructions, userText) {
  var at = codexAccessToken_();
  var headers = {
    Authorization: 'Bearer ' + at,
    originator:    llmProp_('OPENAI_ORIGINATOR', 'my-agent'),
    'OpenAI-Beta': 'responses=experimental'
  };
  var acct = codexAccountId_(at);
  if (acct) headers['chatgpt-account-id'] = acct;

  var res = UrlFetchApp.fetch(CODEX_BASE + '/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({
      model: llmProp_('OPENAI_MODEL', DEFAULT_MODEL),
      instructions: instructions,
      input: [{
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: userText }]
      }],
      stream: true,
      store: false
    }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var raw  = res.getContentText();
  if (code >= 300) throw new Error('codex 後端回 ' + code + ': ' + raw.slice(0, 500));
  return extractText_(raw);
}

/**
 * 從 Responses API 的回應裡挖出文字。
 *
 * codex 後端強制 stream:true（不加會回 400 "Stream must be set to true"），
 * 所以回應一定是 SSE：一堆 data: 開頭的行。UrlFetchApp 不會真的串流，
 * 它把整包 buffer 完才回來，所以這裡直接對完整字串做解析就行。
 *
 * 兩種取法都試：優先累加 output_text.delta，沒有的話從 response.completed
 * 事件裡的完整物件撈。順序不能反 —— delta 累加起來才是完整輸出。
 */
function extractText_(raw) {
  var delta = '';
  var whole = '';

  raw.split('\n').forEach(function (line) {
    line = line.trim();
    if (line.indexOf('data:') !== 0) return;

    var payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    var ev;
    try {
      ev = JSON.parse(payload);
    } catch (err) {
      return;   // 不完整的片段，略過
    }

    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      delta += ev.delta;
    } else if (ev.response) {
      var t = pluckText_(ev.response);
      if (t) whole = t;
    }
  });

  if (delta) return delta;
  if (whole) return whole;

  // 不是 SSE（例如錯誤回應）就當一般 JSON 處理
  try {
    return pluckText_(JSON.parse(raw)) || raw;
  } catch (err) {
    return raw;
  }
}

function pluckText_(obj) {
  if (!obj) return '';
  if (typeof obj.output_text === 'string') return obj.output_text;

  var out = '';
  (obj.output || []).forEach(function (item) {
    (item.content || []).forEach(function (c) {
      if (typeof c.text === 'string') out += c.text;
    });
  });
  return out;
}

/* ========== 意圖判讀 ========== */

/**
 * 把自由語句轉成一個確定的動作。回傳 true 代表已處理（已回覆使用者）。
 *
 * 刻意不讓模型直接動 Trello —— 它只負責「選出動作與卡號」，
 * 實際操作仍走 Commands.gs 裡那套確定性的程式碼。
 */
/** 明顯不是指令的招呼語／應答，直接擋掉不送 LLM，省配額也省延遲 */
var TRIVIAL_RE = /^(hi|hello|hey|嗨|哈囉|你好|早|午安|晚安|謝謝|感謝|3q|收到|好|好的|ok|okay|了解|知道了|辛苦了|讚|太好了|測試|test)[\s!！。，~～、]*$/i;

/**
 * 只做判讀，不執行任何操作。回傳意圖物件，或 null（停用／略過／失敗）。
 * 判讀與執行分開，測試才能安全地乾跑。
 */
function llmIntent_(text) {
  if (!llmEnabled_()) {
    trace_('[LLM] 未啟用（沒有設定 OPENAI_REFRESH_TOKEN），略過判讀');
    return null;
  }

  var t = (text || '').trim();
  if (t.length < 3 || TRIVIAL_RE.test(t)) {
    trace_('[LLM] 略過（招呼語或過短）: ' + JSON.stringify(t));
    return null;
  }

  var cards = openCards_();
  var listing = cards.length
    ? cards.map(function (c) {
        return '- 編號 ' + c.idShort + '（' + c.status + '）：' + c.name;
      }).join('\n')
    : '（目前沒有未結案卡片）';

  var instructions = [
    '你是一個 Trello 問題追蹤看板的指令解析器。',
    '使用者用中文自由描述他想做的事，你要判斷他的意圖。',
    '',
    '目前未結案的卡片：',
    listing,
    '',
    '只輸出一個 JSON 物件，不要有任何其他文字、不要用程式碼區塊包起來。格式：',
    '{"action":"done|take|wait|list|create|none","idShort":<數字或null>,"title":"<建立卡片時的標題>"}',
    '',
    '規則：',
    '- 使用者想結案／關閉／處理完了 → action=done，並從上面清單挑出最符合的 idShort',
    '- 想認領／開始處理 → action=take',
    '- 在等別人回覆 → action=wait',
    '- 想看目前有哪些單 → action=list',
    '- 描述一個新問題 → action=create，title 填問題標題',
    '- 無法判斷、或清單裡找不到對應卡片 → action=none',
    '- 不確定是哪一張卡時一律回 none，不要猜'
  ].join('\n');

  var answer;
  try {
    answer = llmAsk_(instructions, text);
  } catch (err) {
    trace_('[LLM] 呼叫失敗: ' + err);
    return null;   // 交還給指令層的預設提示
  }

  var intent;
  try {
    intent = JSON.parse(answer.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim());
  } catch (err) {
    trace_('[LLM] 回應不是 JSON: ' + answer);
    return null;
  }

  trace_('[LLM] 判讀 = ' + JSON.stringify(intent));
  return intent;
}

/** 判讀 + 執行。回傳 true 代表已處理（已回覆使用者）。 */
function llmHandle_(text, ev) {
  var intent = llmIntent_(text);
  if (!intent) return false;

  switch (intent.action) {
    case 'list':
      reply_(ev.replyToken, renderOpenCards_());
      return true;

    case 'done': case 'take': case 'wait':
      if (!intent.idShort) return false;
      moveByQuery_(String(intent.idShort),
        { done: 'done', take: 'doing', wait: 'waiting' }[intent.action],
        { done: '已解決', take: '處理中', wait: '等回覆' }[intent.action], ev);
      return true;

    case 'create':
      // 不自動建卡 —— 誤判成本太高，改成確認一次
      reply_(ev.replyToken,
        '要開這張單嗎？\n「' + (intent.title || text) + '」\n\n' +
        '確定的話送出：\n#' + (intent.title || text));
      return true;

    default:
      return false;
  }
}

/* ========== 測試 ========== */

/** 驗證 refresh token 能不能換到 access token */
function testLlmToken() {
  if (!llmEnabled_()) {
    console.log('未設定 OPENAI_REFRESH_TOKEN，LLM 層停用中（指令層不受影響）。');
    return;
  }
  var at = codexAccessToken_();
  console.log('access token 取得成功，長度 ' + at.length +
    '\nchatgpt_account_id = ' + (codexAccountId_(at) || '(取不到)'));
}

/**
 * 直接打一次 codex 後端並印出原始回應。
 * 這個端點未公開，回應格式可能改變 —— 如果 llmHandle_ 解析不出東西，
 * 先跑這個看實際長什麼樣子，再調整 extractText_。
 */
function testLlmRaw() {
  var at = codexAccessToken_();
  var headers = {
    Authorization: 'Bearer ' + at,
    originator:    llmProp_('OPENAI_ORIGINATOR', 'my-agent'),
    'OpenAI-Beta': 'responses=experimental'
  };
  var acct = codexAccountId_(at);
  if (acct) headers['chatgpt-account-id'] = acct;

  var res = UrlFetchApp.fetch(CODEX_BASE + '/responses', {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify({
      model: llmProp_('OPENAI_MODEL', DEFAULT_MODEL),
      instructions: '只回答兩個字：測試成功',
      input: [{ type: 'message', role: 'user',
                content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true, store: false
    }),
    muteHttpExceptions: true
  });

  console.log('HTTP ' + res.getResponseCode() + '\n\n原始回應：\n' +
    res.getContentText().slice(0, 3000));
}

/**
 * 乾跑意圖判讀 —— 只呼叫 llmIntent_，不會移動任何卡片。
 * 要改測別的句子就改這裡的字串。
 */
function testLlmIntent() {
  var testText = '報表那個問題處理好了可以關掉';

  console.log('目前未結案卡片：\n' + renderOpenCards_() + '\n');
  console.log("測試句：" + testText);

  var intent = llmIntent_(testText);
  if (!intent) {
    console.log('沒有判讀結果（停用、被略過、或呼叫失敗，原因看上面的記錄）。');
    return;
  }

  console.log('\n判讀結果：' + JSON.stringify(intent));
  if (intent.action === 'none') {
    console.log('→ action=none 表示模型無法對應到任何卡片。\n' +
      '  如果清單裡確實有相符的卡片才算判讀失敗；沒有的話這是正確行為。');
  } else {
    console.log('→ 正式跑的時候會執行這個動作。這裡是乾跑，Trello 沒有被改動。');
  }
}

/* ========== /ask —— 自由對話 ========== */

/** 保留幾輪對話當上下文。太多會讓提示變長、回應變慢，六輪夠用了。 */
var ASK_HISTORY_TURNS = 6;

function askKey_(ev) {
  return 'ASK_' + ((ev.source && ev.source.userId) || 'unknown');
}

function askHistory_(ev) {
  var raw = CacheService.getScriptCache().get(askKey_(ev));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (err) { return []; }
}

function saveAskHistory_(ev, hist) {
  CacheService.getScriptCache().put(askKey_(ev),
    JSON.stringify(hist.slice(-ASK_HISTORY_TURNS)), 1800);   // 30 分鐘沒講話就忘掉
}

/**
 * 和模型自由對話，與意圖判讀完全分開。
 *
 * 上下文是塞進 instructions 而不是用多輪 input 陣列 —— codex 後端對 input 格式
 * 挑剔（少一個 stream 就回 400），已經驗證可行的形狀就不要再冒險。
 */
function llmChat_(question, ev) {
  if (!llmEnabled_()) {
    reply_(ev.replyToken, '目前沒有啟用 AI 對話。\n' +
      '需要在 Apps Script 的指令碼屬性設定 OPENAI_REFRESH_TOKEN。');
    return;
  }

  question = (question || '').trim();

  if (!question) {
    reply_(ev.replyToken, '要問什麼？例如：\n/ask 報表匯出少一列可能是什麼原因\n\n' +
      '/ask clear 可以清掉先前的對話記憶。');
    return;
  }

  if (/^(clear|reset|清除|重來|忘記)$/i.test(question)) {
    CacheService.getScriptCache().remove(askKey_(ev));
    reply_(ev.replyToken, '已清除對話記憶，下一句重新開始。');
    return;
  }

  var hist = askHistory_(ev);
  var context = hist.map(function (h) {
    return '使用者：' + h.q + '\n你：' + h.a;
  }).join('\n\n');

  var instructions = [
    '你在一個 LINE 聊天機器人裡回答同事的問題。',
    '',
    '- 用繁體中文、台灣用語回答，直接講重點，不要客套開場白。',
    '- LINE 不支援 Markdown，不要用 **粗體**、# 標題或表格。要條列就用「- 」開頭。',
    '- 回答控制在 400 字以內，除非對方明確要求詳細說明。',
    '- 不確定的事就說不確定，不要編造。',
    hist.length ? '\n先前的對話（供參考，不用重述）：\n' + context : ''
  ].join('\n');

  trace_('[ask] ' + question.slice(0, 60) + (hist.length ? '　（帶 ' + hist.length + ' 輪上下文）' : ''));

  var answer;
  try {
    answer = llmAsk_(instructions, question);
  } catch (err) {
    trace_('[ask] 失敗: ' + err);
    reply_(ev.replyToken, '問 AI 的時候出錯了。\n' + String(err).slice(0, 200));
    return;
  }

  answer = (answer || '').trim();
  if (!answer) {
    reply_(ev.replyToken, '沒有拿到回應，再問一次看看。');
    return;
  }

  // LINE 單則文字上限 5000 字元，留點餘裕
  if (answer.length > 4500) answer = answer.slice(0, 4500) + '\n…（後面省略）';

  hist.push({ q: question, a: answer });
  saveAskHistory_(ev, hist);

  reply_(ev.replyToken, answer);
}

/**
 * 列出 codex 後端目前提供的模型 slug。
 *
 * 模型名稱會變動，寫死一個猜測值有風險 —— 跑這個拿到確切的 slug，
 * 再填進指令碼屬性 OPENAI_MODEL（會覆蓋 DEFAULT_MODEL）。
 */
function testLlmModels() {
  var at = codexAccessToken_();
  var headers = {
    Authorization: 'Bearer ' + at,
    originator:    llmProp_('OPENAI_ORIGINATOR', 'my-agent')
  };
  var acct = codexAccountId_(at);
  if (acct) headers['chatgpt-account-id'] = acct;

  var res = UrlFetchApp.fetch(CODEX_BASE + '/models?client_version=99.0.0',
    { headers: headers, muteHttpExceptions: true });

  if (res.getResponseCode() >= 300) {
    console.error('取得模型清單失敗 ' + res.getResponseCode() + ': ' +
      res.getContentText().slice(0, 500));
    return;
  }

  var data = JSON.parse(res.getContentText());
  var items = (data && (data.models || data.data)) || data || [];
  var slugs = [];

  items.forEach(function (item) {
    var slug = typeof item === 'string'
      ? item
      : (item && (item.slug || item.id || item.model)) || '';
    if (slug && slugs.indexOf(slug) === -1) slugs.push(slug);
  });

  var current = llmProp_('OPENAI_MODEL', DEFAULT_MODEL);
  console.log('可用模型：\n  ' + slugs.join('\n  ') +
    '\n\n目前使用：' + current +
    (slugs.indexOf(current) === -1
      ? '　← 不在清單裡，呼叫時可能會失敗。請把上面正確的 slug 填進指令碼屬性 OPENAI_MODEL。'
      : '　（在清單裡，沒問題）'));
}
