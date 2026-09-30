/**
 * /ask 的網路搜尋版
 *
 * 在請求上掛 hosted web_search 工具，模型自己判斷要不要查（tool_choice 預設 auto）：
 * 一般知識直接回答，時事、價格、版本號這類會變的資訊才去查。
 * 有查的話，回覆最後附上來源網址。
 *
 * 只有 /ask 用這個。/summary 與自然語言判讀刻意不查網路 ——
 * 它們只該根據對話內容回答，查網路反而會混進不相干的資訊。
 *
 * codex 後端的工具名稱沒有文件，依序試 web_search → web_search_preview，
 * 成功的那個記在指令碼屬性 ASK_SEARCH_TOOL；兩個都被拒就退回不查網路的一般回答。
 * 要重新偵測就把 ASK_SEARCH_TOOL 刪掉。
 *
 * 放在獨立檔案，沒有修改 Llm.gs；共用 Llm.gs 裡的 token、SSE 解析與對話記憶函式。
 */

var ASK_SEARCH_CANDIDATES = ['web_search', 'web_search_preview'];

/** 送一次 codex 請求，tools 可以是 null。回傳 { code, raw } */
function codexPost_(instructions, userText, tools) {
  var at = codexAccessToken_();
  var headers = {
    Authorization: 'Bearer ' + at,
    originator:    llmProp_('OPENAI_ORIGINATOR', 'my-agent'),
    'OpenAI-Beta': 'responses=experimental'
  };
  var acct = codexAccountId_(at);
  if (acct) headers['chatgpt-account-id'] = acct;

  var body = {
    model: llmProp_('OPENAI_MODEL', typeof DEFAULT_MODEL !== 'undefined' ? DEFAULT_MODEL : 'gpt-5.4'),
    instructions: instructions,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] }],
    stream: true,
    store: false
  };
  if (tools) body.tools = tools;

  var res = UrlFetchApp.fetch(CODEX_BASE + '/responses', {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), raw: res.getContentText() };
}

/** 400 的錯誤訊息看起來是在說「這個工具不支援」 */
function isToolRejection_(raw) {
  return /tool|web_search|unsupported|not supported|invalid.*type/i.test(String(raw).slice(0, 800));
}

/**
 * 帶網路搜尋工具詢問。回傳 { text, cites:[{url,title}], searched, tool }
 * tool 為 null 代表這次沒有用搜尋工具（後端不支援，退回一般回答）。
 */
function askWithSearch_(instructions, userText) {
  var P = PropertiesService.getScriptProperties();
  var remembered = P.getProperty('ASK_SEARCH_TOOL');

  if (remembered !== 'none') {
    var order = remembered ? [remembered] : ASK_SEARCH_CANDIDATES;
    for (var i = 0; i < order.length; i++) {
      var r = codexPost_(instructions, userText, [{ type: order[i] }]);
      if (r.code < 300) {
        if (remembered !== order[i]) P.setProperty('ASK_SEARCH_TOOL', order[i]);
        var parsed = parseAskStream_(r.raw);
        parsed.tool = order[i];
        return parsed;
      }
      if (r.code === 400 && isToolRejection_(r.raw)) {
        trace_('[ask] 後端不接受工具 ' + order[i] + '：' + r.raw.slice(0, 200));
        continue;
      }
      throw new Error('codex 後端回 ' + r.code + ': ' + r.raw.slice(0, 300));
    }
    // 候選工具全被拒：記下來，之後不再每次重試
    P.setProperty('ASK_SEARCH_TOOL', 'none');
    trace_('[ask] 網路搜尋工具都不被接受，改成一般回答（刪除 ASK_SEARCH_TOOL 可重新偵測）');
  }

  var plain = codexPost_(instructions, userText, null);
  if (plain.code >= 300) throw new Error('codex 後端回 ' + plain.code + ': ' + plain.raw.slice(0, 300));
  var out = parseAskStream_(plain.raw);
  out.tool = null;
  return out;
}

/**
 * 從 SSE 取出文字、引用來源，以及這次有沒有真的執行搜尋。
 * 文字沿用 Llm.gs 的 extractText_；來源來自 url_citation 註記，
 * 可能出現在串流中的 annotation 事件，或 response.completed 的完整輸出裡，兩處都收。
 */
function parseAskStream_(raw) {
  var cites = [];
  var seen = {};
  var searched = false;

  String(raw).split('\n').forEach(function (line) {
    line = line.trim();
    if (line.indexOf('data:') !== 0) return;
    var p = line.slice(5).trim();
    if (!p || p === '[DONE]') return;

    var ev;
    try { ev = JSON.parse(p); } catch (err) { return; }

    var anns = [];
    if (ev.type === 'response.output_text.annotation.added' && ev.annotation) anns.push(ev.annotation);
    if (ev.item && ev.item.type === 'web_search_call') searched = true;
    if (ev.type === 'response.completed' && ev.response) {
      (ev.response.output || []).forEach(function (it) {
        if (it.type === 'web_search_call') searched = true;
        (it.content || []).forEach(function (c) {
          (c.annotations || []).forEach(function (a) { anns.push(a); });
        });
      });
    }

    anns.forEach(function (a) {
      if (a && a.type === 'url_citation' && a.url && !seen[a.url]) {
        seen[a.url] = true;
        cites.push({ url: a.url, title: a.title || '' });
      }
    });
  });

  return { text: extractText_(raw), cites: cites, searched: searched };
}

/** /ask 主流程（網路搜尋版）。對話記憶沿用 Llm.gs 的 askHistory_ / saveAskHistory_。 */
function llmChatWeb_(question, ev) {
  if (!llmEnabled_()) {
    reply_(ev.replyToken, '目前沒有啟用 AI 對話。\n需要在 Apps Script 的指令碼屬性設定 OPENAI_REFRESH_TOKEN。');
    return;
  }

  question = (question || '').trim();

  if (!question) {
    reply_(ev.replyToken, '要問什麼？例如：\n/ask Trello 免費版最多幾個協作者\n\n' +
      '需要最新資訊時會自動上網查，並附上來源。\n/ask clear 可以清掉先前的對話記憶。');
    return;
  }

  if (/^(clear|reset|清除|重來|忘記)$/i.test(question)) {
    CacheService.getScriptCache().remove(askKey_(ev));
    reply_(ev.replyToken, '已清除對話記憶，下一句重新開始。');
    return;
  }

  var hist = askHistory_(ev);
  var context = hist.map(function (h) { return '使用者：' + h.q + '\n你：' + h.a; }).join('\n\n');
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  var instructions = [
    '你在一個 LINE 聊天機器人裡回答同事的問題。今天是 ' + today + '（台灣時間）。',
    '',
    '- 你可以使用網路搜尋。問題牽涉時事、價格、版本、法規更新、日期這類會變動的資訊，',
    '  或你不確定答案時，先搜尋再回答；一般常識與推理題不必搜尋。',
    '- 用繁體中文、台灣用語回答，直接講重點，不要客套開場白。',
    '- LINE 不支援 Markdown，不要用 **粗體**、# 標題、表格或 [文字](網址) 連結格式。要條列就用「- 」開頭。',
    '- 不要在內文貼網址，來源會由系統另外附在最後。',
    '- 回答控制在 400 字以內，除非對方明確要求詳細說明。',
    '- 搜尋結果彼此矛盾或查不到時，照實說，不要編造。',
    hist.length ? '\n先前的對話（供參考，不用重述）：\n' + context : ''
  ].join('\n');

  trace_('[ask] ' + question.slice(0, 60) + (hist.length ? '　（帶 ' + hist.length + ' 輪上下文）' : ''));

  var r;
  try {
    r = askWithSearch_(instructions, question);
  } catch (err) {
    trace_('[ask] 失敗: ' + err);
    reply_(ev.replyToken, '問 AI 的時候出錯了。\n' + String(err).slice(0, 200));
    return;
  }

  var answer = (r.text || '').trim();
  if (!answer) {
    reply_(ev.replyToken, '沒有拿到回應，再問一次看看。');
    return;
  }

  trace_('[ask] 工具=' + (r.tool || '無') + '　有搜尋=' + r.searched + '　來源 ' + r.cites.length + ' 筆');

  // 對話記憶只存回答本體，不含來源清單，避免下一輪提示越滾越長
  hist.push({ q: question, a: answer.slice(0, 1500) });
  saveAskHistory_(ev, hist);

  if (r.cites.length) {
    answer += '\n\n來源：\n' + r.cites.slice(0, 3).map(function (c) {
      return '- ' + (c.title ? c.title.slice(0, 40) + '\n  ' : '') + c.url;
    }).join('\n');
  }

  if (answer.length > 4500) answer = answer.slice(0, 4500) + '\n…（後面省略）';
  reply_(ev.replyToken, answer);
}

/* ========== 測試 ========== */

/**
 * 在編輯器實測網路搜尋：問一個一定要查網路才答得出來的問題，印出用了哪個工具、
 * 有沒有真的搜尋、來源網址。部署前先跑這個確認後端支援。
 */
function testAskSearch() {
  var q = '今天（' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd') +
          '）台灣加權指數收盤大約多少點？一句話回答。';
  var r = askWithSearch_('用繁體中文簡短回答。需要時使用網路搜尋。', q);
  console.log('問題：' + q +
    '\n\n使用的工具：' + (r.tool || '無（後端不支援搜尋，已退回一般回答）') +
    '\n實際有搜尋：' + r.searched +
    '\n\n回答：' + r.text +
    '\n\n來源（' + r.cites.length + ' 筆）：\n' +
    r.cites.map(function (c) { return '  ' + c.url; }).join('\n'));
}
