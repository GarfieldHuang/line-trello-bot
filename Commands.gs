/**
 * 指令層 —— 不需要 LLM 的確定性操作。
 *
 * /list                看未結案卡片
 * /done <編號或關鍵字>  移到「已解決」
 * /take <編號或關鍵字>  移到「處理中」
 * /wait <編號或關鍵字>  移到「等回覆」
 * /help                說明
 *
 * 卡片可以用兩種方式指定：
 *   - 卡號（Trello 卡片左下角那個 #12 的數字）
 *   - 標題關鍵字（子字串比對，不分大小寫；命中多張會列出來讓你選）
 */

/* ========== 清單設定 ========== */

function lists_() {
  var P = PropertiesService.getScriptProperties();
  return {
    todo:    P.getProperty('TRELLO_LIST_ID'),        // 待確認
    doing:   P.getProperty('TRELLO_LIST_DOING'),     // 處理中
    waiting: P.getProperty('TRELLO_LIST_WAITING'),   // 等回覆
    done:    P.getProperty('TRELLO_LIST_DONE')       // 已解決
  };
}

/* ========== 指令分派 ========== */

function handleCommand_(input, ev) {
  var m = input.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return;

  var cmd = m[1].toLowerCase();
  var arg = (m[2] || '').trim();

  trace_('[指令] ' + cmd + '　參數=' + JSON.stringify(arg));

  switch (cmd) {
    case 'list': case 'ls': case '單':
      reply_(ev.replyToken, /^(all|全部|含已解決)$/i.test(arg)
        ? renderCards_(allCards_(), ['待確認', '處理中', '等回覆', '已解決'])
        : renderOpenCards_());
      return;

    case 'open': case 'reopen': case 'todo': case '重開': case '待確認':
      moveByQuery_(arg, 'todo', '待確認', ev);
      return;

    case 'done': case 'close': case '結案':
      moveByQuery_(arg, 'done', '已解決', ev);
      return;

    case 'take': case 'doing': case '認領':
      moveByQuery_(arg, 'doing', '處理中', ev);
      return;

    case 'wait': case 'waiting': case '等回覆':
      moveByQuery_(arg, 'waiting', '等回覆', ev);
      return;

    case 'show': case 'view': case '看':
      showCard_(arg, ev);
      return;

    case 'note': case 'comment': case '留言':
      addNote_(arg, ev);
      return;

    case 'rename': case '改名':
      renameCard_(arg, ev);
      return;

    case 'due': case '期限':
      setDue_(arg, ev);
      return;

    case 'bind': case '綁定':
      bindMember_(arg, ev);
      return;

    case 'ask': case '問':
      llmChat_(arg, ev);
      return;

    case 'help': case '?': case '說明':
      reply_(ev.replyToken, helpText_());
      return;

    default:
      reply_(ev.replyToken, '不認得的指令：/' + cmd + '\n\n' + helpText_());
  }
}

/**
 * 說明文字。
 *
 * 指令裡的數字是「卡片編號」。寫死一個 12 會讓人誤以為那是固定參數，
 * 所以優先拿看板上真實存在的卡號當範例 —— 使用者可以直接照著打。
 * 沒有未結案卡片時才退回 <編號> 這種佔位寫法。
 */
function helpText_() {
  var n = null;
  try {
    var cards = openCards_();
    if (cards.length) n = cards[0].idShort;
  } catch (err) {
    // Trello 掛掉也不能讓 /help 失效
  }

  var N = n === null ? '<編號>' : String(n);
  var eg = n === null
    ? '（<編號> 請換成實際卡號，用 /list 查）'
    : '（' + N + ' 是範例，換成你要操作的卡號，用 /list 查）';

  return [
    '【開單】',
    '  私訊：#問題描述',
    '  群組：@@@問題描述',
    '  （群組也可以 @我，但 LINE 電腦版無法 @ 官方帳號，用 @@@ 比較保險）',
    '',
    '【看】',
    '  /list             未結案清單',
    '  /list all         含已解決的全部',
    '  /show ' + N + '   看內容與留言',
    '',
    '【改狀態】四個狀態可以互相切換',
    '  /open ' + N + '   放回待確認（結案後要重開也用這個）',
    '  /take ' + N + '   認領，改成處理中',
    '  /wait ' + N + '   改成等回覆',
    '  /done ' + N + '   結案',
    '  ' + eg,
    '  編號也可以換成關鍵字，例如 /done 報表',
    '',
    '【討論】',
    '  /note ' + N + ' 內容   在卡片留言',
    '  直接傳圖片         附到你最近操作的那張卡',
    '                   （群組限 5 分鐘內，私訊 30 分鐘內）',
    '',
    '【問 AI】',
    '  /ask 問題          自由對話，會記得前幾輪',
    '  /ask clear        清掉對話記憶',
    '',
    '【其他】',
    '  /rename ' + N + ' 新標題',
    '  /due ' + N + ' 8/25   設期限（clear 可清除）',
    '  /bind 帳號         綁定 Trello 帳號，認領時標記到你',
    '  /help             這則說明'
  ].join('\n');
}

/* ========== 查詢與移動 ========== */

/** 依序讀取指定的清單，攤平成一個陣列 */
function cardsFrom_(pairs) {
  var out = [];
  pairs.forEach(function (pair) {
    if (!pair[1]) return;
    trelloGet_('/lists/' + pair[1] + '/cards', { fields: 'idShort,name,shortUrl' })
      .forEach(function (c) {
        out.push({ idShort: c.idShort, name: c.name, url: c.shortUrl, id: c.id, status: pair[0] });
      });
  });
  return out;
}

/** 未結案卡片（待確認 + 處理中 + 等回覆），/list 顯示用 */
function openCards_() {
  var L = lists_();
  return cardsFrom_([['待確認', L.todo], ['處理中', L.doing], ['等回覆', L.waiting]]);
}

/**
 * 四個清單全部，查找用。
 *
 * 查找一定要涵蓋「已解決」—— 否則結案後那張卡就從所有指令的視野裡消失，
 * 再也搬不回來。狀態之間必須能雙向流動。
 */
function allCards_() {
  var L = lists_();
  return cardsFrom_([['待確認', L.todo], ['處理中', L.doing],
                     ['等回覆', L.waiting], ['已解決', L.done]]);
}

function renderCards_(cards, order) {
  if (!cards.length) return '目前沒有卡片。';

  var byStatus = {};
  cards.forEach(function (c) {
    (byStatus[c.status] = byStatus[c.status] || []).push(c);
  });

  var out = [];
  order.forEach(function (s) {
    if (!byStatus[s]) return;
    out.push('【' + s + '】');
    byStatus[s].forEach(function (c) {
      out.push('  ' + c.idShort + '. ' + c.name);
    });
  });
  return out.join('\n');
}

function renderOpenCards_() {
  var cards = openCards_();
  if (!cards.length) return '目前沒有未結案的卡片。\n（/list all 可以看含已解決的全部）';

  return renderCards_(cards, ['待確認', '處理中', '等回覆']) +
    '\n\n/done <編號> 結案　/list all 看全部';
}

/**
 * 依查詢字串找卡片。
 * 純數字視為卡號（精確比對），否則當標題關鍵字（子字串，不分大小寫）。
 * 回傳 { card } / { candidates } / { empty:true }
 */
function findCard_(query) {
  var cards = allCards_();
  if (!query) return { candidates: cards };

  if (/^\d+$/.test(query)) {
    var n = parseInt(query, 10);
    var hit = cards.filter(function (c) { return c.idShort === n; });
    return hit.length ? { card: hit[0] } : { empty: true };
  }

  var q = query.toLowerCase();
  var matches = cards.filter(function (c) {
    return c.name.toLowerCase().indexOf(q) !== -1;
  });

  if (matches.length === 0) return { empty: true };
  if (matches.length === 1) return { card: matches[0] };

  // 關鍵字同時命中未結案與已解決時，優先取未結案那張 ——
  // 「/done 報表」講的幾乎不會是三個月前已經關掉的那張。
  var active = matches.filter(function (c) { return c.status !== '已解決'; });
  if (active.length === 1) return { card: active[0] };

  return { candidates: matches };
}

function moveByQuery_(query, targetKey, label, ev) {
  if (!query) {
    reply_(ev.replyToken, '要指定哪一張卡片，例如 /done 12 或 /done 報表\n\n' + renderOpenCards_());
    return;
  }

  var target = lists_()[targetKey];
  if (!target) {
    var propName = { todo: 'TRELLO_LIST_ID', doing: 'TRELLO_LIST_DOING',
                     waiting: 'TRELLO_LIST_WAITING', done: 'TRELLO_LIST_DONE' }[targetKey];
    reply_(ev.replyToken, '尚未設定「' + label + '」清單的 ID。\n' +
      '請到 Apps Script 的「專案設定 > 指令碼屬性」新增：\n  ' + propName + '\n' +
      '值可以用 setupShowAllListIds 查。');
    return;
  }

  var res = findCard_(query);

  if (res.empty) {
    reply_(ev.replyToken, '找不到符合「' + query + '」的未結案卡片。\n\n' + renderOpenCards_());
    return;
  }

  if (res.candidates) {
    var lines = res.candidates.map(function (c) { return '  ' + c.idShort + '. ' + c.name; });
    reply_(ev.replyToken,
      '「' + query + '」符合多張卡片，請改用編號：\n' + lines.join('\n'));
    return;
  }

  trelloPut_('/cards/' + res.card.id, { idList: target });
  console.log('[移動] #' + res.card.idShort + ' → ' + label);

  var extra = '';

  // 認領時順手把人加進卡片成員 —— 「誰在處理」比「在哪一欄」更重要。
  // 需要先用 /bind 綁定 Trello 帳號，沒綁就只移動不標記。
  if (targetKey === 'doing') {
    var memberId = PropertiesService.getScriptProperties().getProperty(bindKey_(ev));
    if (memberId) {
      try {
        trelloPost_('/cards/' + res.card.id + '/idMembers', { value: memberId });
        extra = '\n已把你加為卡片成員。';
      } catch (err) {
        console.warn('[認領] 加入成員失敗: ' + err);   // 已經移動了，不讓這步擋住流程
      }
    } else {
      extra = '\n（用 /bind 綁定 Trello 帳號，之後認領會自動標記到你）';
    }
  }

  rememberCard_(ev, res.card);
  reply_(ev.replyToken, '已將 ' + res.card.idShort + '. ' + res.card.name +
    '\n改為「' + label + '」\n' + res.card.url + extra);
}

/* ========== 看內容與留言 ========== */

/**
 * 解析「第一個詞是卡片指定字串，其餘是內容」的參數。
 * 純數字優先當卡號；否則整串前綴都可能是關鍵字，所以只吃第一個空白前的詞。
 */
function splitCardArg_(arg) {
  var m = (arg || '').match(/^(\S+)\s*([\s\S]*)$/);
  return m ? { query: m[1], rest: (m[2] || '').trim() } : { query: '', rest: '' };
}

/**
 * 找卡片，找不到／有歧義時直接回覆使用者並回傳 null。
 *
 * 找到就順手記成「目前這張卡」。使用者打出卡號的當下就已經表達了對象，
 * 即使那道指令因為缺參數而中斷（例如只打了 /note 9），
 * 接著傳的圖片也該附到這張 —— 不記的話會變成「明明指名了卻沒反應」。
 */
function resolveCard_(query, ev) {
  if (!query) {
    reply_(ev.replyToken, '要指定哪一張卡片。\n\n' + renderOpenCards_());
    return null;
  }
  var res = findCard_(query);
  if (res.empty) {
    reply_(ev.replyToken, '找不到符合「' + query + '」的未結案卡片。\n\n' + renderOpenCards_());
    return null;
  }
  if (res.candidates) {
    reply_(ev.replyToken, '「' + query + '」符合多張，請改用編號：\n' +
      res.candidates.map(function (c) { return '  ' + c.idShort + '. ' + c.name; }).join('\n'));
    return null;
  }
  rememberCard_(ev, res.card);
  return res.card;
}

function showCard_(arg, ev) {
  var card = resolveCard_(splitCardArg_(arg).query, ev);
  if (!card) return;

  var full = trelloGet_('/cards/' + card.id, {
    fields: 'name,desc,due,dueComplete,shortUrl'
  });
  var comments = trelloGet_('/cards/' + card.id + '/actions', {
    filter: 'commentCard', limit: 5
  });

  var out = [card.idShort + '. ' + full.name, '狀態：' + card.status];
  if (full.due) {
    out.push('期限：' + Utilities.formatDate(new Date(full.due), 'Asia/Taipei', 'yyyy-MM-dd HH:mm') +
      (full.dueComplete ? '（已完成）' : ''));
  }

  if (full.desc) {
    var desc = full.desc.split('---')[0].trim();
    if (desc) out.push('', desc.length > 300 ? desc.slice(0, 300) + '…' : desc);
  }

  if (comments.length) {
    out.push('', '留言（最新 ' + comments.length + ' 則）：');
    // Trello 回傳是新到舊，反過來讀比較符合對話順序
    comments.slice().reverse().forEach(function (a) {
      var when = Utilities.formatDate(new Date(a.date), 'Asia/Taipei', 'MM/dd HH:mm');
      out.push('  [' + when + '] ' + (a.data.text || '').replace(/\n/g, ' '));
    });
  } else {
    out.push('', '（還沒有留言）');
  }

  out.push('', full.shortUrl);
  reply_(ev.replyToken, out.join('\n'));
  rememberCard_(ev, card);
}

function addNote_(arg, ev) {
  var parts = splitCardArg_(arg);
  var card = resolveCard_(parts.query, ev);
  if (!card) return;

  if (!parts.rest) {
    // 卡片已經在 resolveCard_ 裡記住了，順便告訴使用者圖片也能直接傳
    reply_(ev.replyToken,
      '要留言的內容是什麼？例如：\n/note ' + card.idShort + ' 已經跟廠商確認過了\n\n' +
      '如果是要附圖片，直接傳圖就好 —— 現在的目標是 ' + card.idShort + '. ' + card.name);
    return;
  }

  // Trello 留言的作者一律是 API token 的擁有者，所以把真正的發話者寫進內容裡，
  // 否則看板上會變成所有留言都是同一個人講的。
  var who = senderName_(ev);
  trelloPost_('/cards/' + card.id + '/actions/comments', {
    text: who + '：' + parts.rest
  });

  console.log('[留言] #' + card.idShort + ' by ' + who);
  reply_(ev.replyToken, '已留言到 ' + card.idShort + '. ' + card.name + '\n' + card.url);
  rememberCard_(ev, card);
}

function renameCard_(arg, ev) {
  var parts = splitCardArg_(arg);
  var card = resolveCard_(parts.query, ev);
  if (!card) return;

  if (!parts.rest) {
    reply_(ev.replyToken, '新標題是什麼？例如：\n/rename ' + card.idShort + ' 匯出報表少最後一列');
    return;
  }

  trelloPut_('/cards/' + card.id, { name: parts.rest });
  reply_(ev.replyToken, '已改名：\n' + card.idShort + '. ' + parts.rest + '\n' + card.url);
  rememberCard_(ev, card);
}

/**
 * 設定期限。接受 8/25、2026-08-25、8/25 17:00 這幾種寫法，或 clear 清除。
 * 只給月日時視為今年；若該日期已經過了就算明年 —— 講「8/25」通常是指未來。
 */
function setDue_(arg, ev) {
  var parts = splitCardArg_(arg);
  var card = resolveCard_(parts.query, ev);
  if (!card) return;

  var spec = parts.rest;
  if (!spec) {
    reply_(ev.replyToken, '期限是什麼時候？例如：\n/due ' + card.idShort +
      ' 8/25\n/due ' + card.idShort + ' clear（清除）');
    return;
  }

  if (/^(clear|none|清除|取消)$/i.test(spec)) {
    trelloPut_('/cards/' + card.id, { due: '' });
    reply_(ev.replyToken, '已清除 ' + card.idShort + ' 的期限。');
    return;
  }

  var due = parseDue_(spec);
  if (!due) {
    reply_(ev.replyToken, '看不懂「' + spec + '」。可以用 8/25、2026-08-25、8/25 17:00。');
    return;
  }

  trelloPut_('/cards/' + card.id, { due: due.toISOString() });
  reply_(ev.replyToken, '已設定 ' + card.idShort + '. ' + card.name + ' 的期限為\n' +
    Utilities.formatDate(due, 'Asia/Taipei', 'yyyy-MM-dd HH:mm'));
  rememberCard_(ev, card);
}

function parseDue_(spec) {
  var now = new Date();
  var m;

  m = spec.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 18, m[5] ? +m[5] : 0);
  }

  m = spec.match(/^(\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    var d = new Date(now.getFullYear(), +m[1] - 1, +m[2], m[3] ? +m[3] : 18, m[4] ? +m[4] : 0);
    // 講「8/25」而今天已經過了 8/25，指的通常是明年
    if (d.getTime() < now.getTime() - 86400000) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  return null;
}

/* ========== Trello 帳號綁定 ========== */

function bindKey_(ev) {
  return 'BIND_' + ((ev.source && ev.source.userId) || 'unknown');
}

function bindMember_(arg, ev) {
  var name = (arg || '').trim().replace(/^@/, '');
  if (!name) {
    var cur = PropertiesService.getScriptProperties().getProperty(bindKey_(ev));
    reply_(ev.replyToken, cur
      ? '你目前綁定的 Trello 帳號 id 是 ' + cur + '\n要換的話：/bind 新帳號'
      : '還沒綁定。用 /bind 你的Trello使用者名稱\n（在 Trello 個人資料頁網址 /u/ 後面那串）');
    return;
  }

  var member;
  try {
    member = trelloGet_('/members/' + encodeURIComponent(name), { fields: 'id,fullName,username' });
  } catch (err) {
    reply_(ev.replyToken, '找不到 Trello 使用者「' + name + '」。\n' +
      '請用使用者名稱，不是顯示名稱 —— 在你的 Trello 個人資料頁網址 /u/ 後面那串。');
    return;
  }

  PropertiesService.getScriptProperties().setProperty(bindKey_(ev), member.id);
  reply_(ev.replyToken, '已綁定：' + member.fullName + '（@' + member.username + '）\n' +
    '之後你用 /take 認領時會把你加進卡片成員。');
}

/* ========== 記住最近操作的卡片（給圖片附加用） ========== */

function rememberCard_(ev, card) {
  var uid = ev.source && ev.source.userId;
  if (!uid || !card) return;
  CacheService.getScriptCache().put('LASTCARD_' + uid,
    JSON.stringify({
      id: card.id, idShort: card.idShort, name: card.name, url: card.url,
      at: Math.floor(new Date().getTime() / 1000)
    }),
    1800);   // 30 分鐘
}

function lastCard_(ev) {
  var uid = ev.source && ev.source.userId;
  if (!uid) return null;
  var raw = CacheService.getScriptCache().get('LASTCARD_' + uid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/* ========== 圖片附加 ========== */

/**
 * 把 LINE 的圖片訊息附到使用者最近操作的那張卡片。
 *
 * LINE 的圖片內容要打 api-data.line.me（不是 api.line.me），這點很容易寫錯。
 */
/**
 * 群組裡的圖片只在「剛剛才操作過卡片」的短時間內收。
 *
 * 私訊視窗 30 分鐘沒問題 —— 那個對話框本來就只拿來開單。
 * 但群組是大家聊天的地方，隨手傳的照片跟卡片無關的機率高得多，
 * 窗口拉長只會把無關的圖片灌進卡片裡。
 */
var GROUP_IMAGE_WINDOW = 300;   // 秒

function attachImage_(ev) {
  var isDirect = (ev.source && ev.source.type === 'user');
  var card = lastCard_(ev);

  if (!isDirect) {
    // 群組：沒有近期操作過卡片就當作與 bot 無關，安靜略過，不要回話洗版
    if (!card) {
      trace_('[圖片] 群組圖片但這個人沒有進行中的卡片，略過');
      return;
    }
    var age = Math.floor(new Date().getTime() / 1000) - (card.at || 0);
    if (age > GROUP_IMAGE_WINDOW) {
      trace_('[圖片] 群組圖片但距離上次操作已 ' + age + ' 秒，超過視窗，略過');
      return;
    }
  }

  // 沒有目標卡片就不收 —— 圖片一定要先有歸屬，
  // 否則「這張圖是哪件事的」只能靠猜。
  if (!card) {
    reply_(ev.replyToken,
      '還沒有指定卡片，這張圖沒有收。\n\n' +
      '先開單：#問題描述\n' +
      '或指定一張現有的：/show 編號\n' +
      '指定後 30 分鐘內傳的圖都會附到那張卡。');
    return;
  }

  var r = attachToCard_(ev.message.id, card);
  reply_(ev.replyToken, r.ok
    ? '圖片已附到 ' + card.idShort + '. ' + card.name + '\n' + card.url
    : r.msg + '\n' + card.url);
}

/** 下載 LINE 圖片並上傳成 Trello 附件。回傳 {ok:true} 或 {ok:false, msg} */
function attachToCard_(messageId, card) {
  // 圖片內容要打 api-data.line.me，不是 api.line.me
  var res = UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + messageId + '/content',
    { headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
      muteHttpExceptions: true });

  if (res.getResponseCode() !== 200) {
    trace_('[圖片] 下載失敗 ' + res.getResponseCode());
    return { ok: false, msg: '圖片抓不下來，請直接到 Trello 卡片貼上。' };
  }

  var stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss');
  var blob = res.getBlob().setName('line-' + stamp + '.jpg');
  var auth = trelloAuth_();

  var up = UrlFetchApp.fetch('https://api.trello.com/1/cards/' + card.id + '/attachments', {
    method: 'post',
    payload: { key: auth.key, token: auth.token, file: blob },
    muteHttpExceptions: true
  });

  if (up.getResponseCode() >= 300) {
    trace_('[圖片] 上傳失敗 ' + up.getResponseCode() + ': ' + up.getContentText());
    return { ok: false, msg: '上傳到 Trello 失敗，請直接到卡片貼上。' };
  }

  trace_('[圖片] 已附到 #' + card.idShort);
  return { ok: true };
}

/* ========== Trello REST 小工具 ========== */

function trelloAuth_() {
  var P = PropertiesService.getScriptProperties();
  return { key: P.getProperty('TRELLO_KEY'), token: P.getProperty('TRELLO_TOKEN') };
}

function trelloGet_(path, params) {
  var q = trelloAuth_();
  Object.keys(params || {}).forEach(function (k) { q[k] = params[k]; });
  var qs = Object.keys(q).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]);
  }).join('&');

  var res = UrlFetchApp.fetch('https://api.trello.com/1' + path + '?' + qs,
    { muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) {
    throw new Error('Trello GET ' + path + ' 失敗 ' + res.getResponseCode() +
      ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

function trelloPost_(path, payload) {
  var body = trelloAuth_();
  Object.keys(payload || {}).forEach(function (k) { body[k] = payload[k]; });

  var res = UrlFetchApp.fetch('https://api.trello.com/1' + path, {
    method: 'post', payload: body, muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Trello POST ' + path + ' 失敗 ' + res.getResponseCode() +
      ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

function trelloPut_(path, payload) {
  var body = trelloAuth_();
  Object.keys(payload || {}).forEach(function (k) { body[k] = payload[k]; });

  var res = UrlFetchApp.fetch('https://api.trello.com/1' + path, {
    method: 'put', payload: body, muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Trello PUT ' + path + ' 失敗 ' + res.getResponseCode() +
      ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

/* ========== 設定輔助 ========== */

/** 列出看板所有清單 ID，用來填四個 TRELLO_LIST_* 屬性 */
function setupShowAllListIds() {
  var L = lists_();
  console.log('目前設定：\n' +
    '  TRELLO_LIST_ID (待確認)      = ' + (L.todo || '(未設定)') + '\n' +
    '  TRELLO_LIST_DOING (處理中)   = ' + (L.doing || '(未設定)') + '\n' +
    '  TRELLO_LIST_WAITING (等回覆) = ' + (L.waiting || '(未設定)') + '\n' +
    '  TRELLO_LIST_DONE (已解決)    = ' + (L.done || '(未設定)'));
  setupListBoardLists();
}

/** 不經過 LINE，直接測試指令層 */
function testCommands() {
  console.log(renderOpenCards_());
}
