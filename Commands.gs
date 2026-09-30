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

/* ========== 專案（群組 → 看板）路由 ========== */

/**
 * 一個 bot 服務多個專案：每個 LINE 群組可以綁定自己的 Trello 看板。
 *
 *   群組   → GROUP_<groupId> 屬性裡記的看板；沒綁定就用預設看板
 *   私訊   → USE_<userId> 指到的群組專案（用 /use 切換）；沒設定就用預設看板
 *   預設   → 原本的 TRELLO_LIST_* 四個屬性
 *
 * 預設看板保留原本的屬性，所以既有群組什麼都不用做就能繼續運作。
 */
var STATUS_NAMES = { todo: '待確認', doing: '處理中', waiting: '等回覆', done: '已解決' };

function defaultProject_() {
  var P = PropertiesService.getScriptProperties();
  return {
    key: 'default',
    name: P.getProperty('DEFAULT_PROJECT_NAME') || '預設專案',
    isDefault: true,
    lists: {
      todo:    P.getProperty('TRELLO_LIST_ID'),
      doing:   P.getProperty('TRELLO_LIST_DOING'),
      waiting: P.getProperty('TRELLO_LIST_WAITING'),
      done:    P.getProperty('TRELLO_LIST_DONE')
    }
  };
}

function loadProject_(key) {
  if (!key || key === 'default') return null;
  var raw = PropertiesService.getScriptProperties().getProperty('GROUP_' + key);
  if (!raw) return null;
  try {
    var p = JSON.parse(raw);
    p.key = key;
    return p;
  } catch (err) {
    return null;
  }
}

/** 這則訊息屬於哪個專案 */
function projectOf_(ev) {
  var src = (ev && ev.source) || {};
  var gid = src.groupId || src.roomId;

  if (gid) return loadProject_(gid) || defaultProject_();

  if (src.userId) {
    var use = PropertiesService.getScriptProperties().getProperty('USE_' + src.userId);
    var p = loadProject_(use);
    if (p) return p;
  }
  return defaultProject_();
}

/** 目前事件所屬專案的四個清單 id。在編輯器手動執行時（沒有事件）回傳預設看板。 */
function lists_() {
  return projectOf_(CURRENT_EV).lists;
}

/** 所有已綁定的群組專案 */
function allProjects_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var out = [];
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('GROUP_') !== 0) return;
    try {
      var p = JSON.parse(props[k]);
      p.key = k.slice(6);
      out.push(p);
    } catch (err) { /* 壞掉的紀錄略過 */ }
  });
  out.sort(function (a, b) { return (a.boundAt || 0) - (b.boundAt || 0); });
  return out;
}

/* ========== /setup：把群組綁到看板 ========== */

/**
 * 只有 SETUP_ADMINS 裡的人能綁定。
 *
 * bot 用的是你的 Trello token，它看得到你帳號底下所有看板。
 * 如果任何群組成員都能 /setup，知道網址的人就能把群組綁到你其他的私人看板，
 * 再用 /list 把內容讀出來。所以預設關閉，要明確授權。
 */
function isSetupAdmin_(ev) {
  var uid = ev.source && ev.source.userId;
  var raw = PropertiesService.getScriptProperties().getProperty('SETUP_ADMINS') || '';
  return !!uid && raw.split(/[\s,]+/).indexOf(uid) !== -1;
}

function setupGroup_(arg, ev) {
  var src = ev.source || {};
  var gid = src.groupId || src.roomId;

  if (!gid) {
    reply_(ev.replyToken,
      '/setup 要在群組裡執行，把「那個群組」綁到看板。\n' +
      '私訊要切換專案請用 /use。');
    return;
  }

  if (!isSetupAdmin_(ev)) {
    reply_(ev.replyToken,
      '你沒有 /setup 的權限。\n\n' +
      '管理員請到 Apps Script 的指令碼屬性，在 SETUP_ADMINS 加入這個 userId：\n' +
      (src.userId || '(取不到)') + '\n\n多個人用逗號分隔。');
    return;
  }

  var m = (arg || '').match(/trello\.com\/b\/([A-Za-z0-9]+)/);
  if (!m) {
    reply_(ev.replyToken, '請附上看板網址，例如：\n/setup https://trello.com/b/aBcD1234/my-board');
    return;
  }

  var board;
  try {
    board = trelloGet_('/boards/' + m[1], { fields: 'id,name,shortUrl' });
  } catch (err) {
    reply_(ev.replyToken, '讀不到這個看板。確認網址正確，而且看板在 bot 所用的 Trello 帳號底下。');
    return;
  }

  // 依名稱對應四個清單，缺的就建起來 —— 新看板直接 /setup 就能用
  var existing = trelloGet_('/boards/' + board.id + '/lists', { fields: 'id,name', filter: 'open' });
  var lists = {};
  var created = [];

  ['todo', 'doing', 'waiting', 'done'].forEach(function (key) {
    var want = STATUS_NAMES[key];
    var hit = existing.filter(function (l) { return l.name.trim() === want; })[0];
    if (hit) {
      lists[key] = hit.id;
    } else {
      var l = trelloPost_('/lists', { name: want, idBoard: board.id, pos: 'bottom' });
      lists[key] = l.id;
      created.push(want);
    }
  });

  var groupName = lineGroupName_(src) || board.name;
  PropertiesService.getScriptProperties().setProperty('GROUP_' + gid, JSON.stringify({
    name: board.name,
    groupName: groupName,
    url: board.shortUrl,
    lists: lists,
    boundAt: Math.floor(new Date().getTime() / 1000)
  }));

  trace_('[setup] ' + gid + ' → ' + board.name);

  reply_(ev.replyToken, [
    '已綁定：這個群組 → ' + board.name,
    board.shortUrl,
    '',
    created.length
      ? '看板原本缺少的清單已自動建立：' + created.join('、')
      : '四個清單都已存在，直接對應。',
    '',
    '之後這個群組的開單、/list、/done 都只會動這個看板。'
  ].join('\n'));
}

/** LINE 群組名稱，拿不到就回 null（多人聊天室沒有名稱） */
function lineGroupName_(src) {
  if (!src.groupId) return null;
  try {
    var res = UrlFetchApp.fetch(
      'https://api.line.me/v2/bot/group/' + src.groupId + '/summary',
      { headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
        muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText()).groupName || null;
  } catch (err) {
    return null;
  }
}

/* ========== /use：私訊切換專案 ========== */

function useProject_(arg, ev) {
  var src = ev.source || {};

  if (src.groupId || src.roomId) {
    reply_(ev.replyToken, '群組的專案是固定的（由 /setup 決定），/use 只在私訊有用。\n' +
      '目前這個群組：' + projectOf_(ev).name);
    return;
  }

  var projects = allProjects_();
  var q = (arg || '').trim();

  if (!q) {
    var cur = projectOf_(ev);
    var lines = ['目前私訊的專案：' + cur.name, '', '可切換的專案：', '  0. ' + defaultProject_().name + '（預設）'];
    projects.forEach(function (p, i) {
      lines.push('  ' + (i + 1) + '. ' + p.name + (p.groupName && p.groupName !== p.name ? '（' + p.groupName + '）' : ''));
    });
    lines.push('', '用 /use 編號 或 /use 名稱 切換');
    reply_(ev.replyToken, lines.join('\n'));
    return;
  }

  var P = PropertiesService.getScriptProperties();

  if (q === '0' || /^(default|預設)$/i.test(q)) {
    P.deleteProperty('USE_' + src.userId);
    reply_(ev.replyToken, '已切換到：' + defaultProject_().name);
    return;
  }

  var target = null;
  if (/^\d+$/.test(q)) {
    target = projects[parseInt(q, 10) - 1] || null;
  } else {
    var ql = q.toLowerCase();
    var hits = projects.filter(function (p) {
      return (p.name || '').toLowerCase().indexOf(ql) !== -1 ||
             (p.groupName || '').toLowerCase().indexOf(ql) !== -1;
    });
    if (hits.length > 1) {
      reply_(ev.replyToken, '「' + q + '」符合多個專案，請改用編號：\n' +
        hits.map(function (p) { return '  ' + (projects.indexOf(p) + 1) + '. ' + p.name; }).join('\n'));
      return;
    }
    target = hits[0] || null;
  }

  if (!target) {
    reply_(ev.replyToken, '找不到「' + q + '」這個專案。打 /use 看清單。');
    return;
  }

  P.setProperty('USE_' + src.userId, target.key);
  reply_(ev.replyToken, '已切換到：' + target.name + '\n之後私訊的開單與指令都會用這個看板。\n' + (target.url || ''));
}

/** /where：目前這則訊息會用哪個看板 */
function whereAmI_(ev) {
  var p = projectOf_(ev);
  var src = ev.source || {};
  var inGroup = !!(src.groupId || src.roomId);
  var hint = '';
  if (p.isDefault) {
    hint = inGroup
      ? '\n\n這個群組還沒 /setup，用的是預設看板。'
      : '\n\n私訊目前用預設看板，/use 可以切換。';
  }
  reply_(ev.replyToken, '目前專案：' + p.name + (p.url ? '\n' + p.url : '') + hint);
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
        ? projectHeader_() + renderCards_(allCards_(), ['待確認', '處理中', '等回覆', '已解決'])
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

    case 'setup':
      setupGroup_(arg, ev);
      return;

    case 'use': case '專案':
      useProject_(arg, ev);
      return;

    case 'where': case 'project':
      whereAmI_(ev);
      return;

    case 'bind': case '綁定':
      bindMember_(arg, ev);
      return;

    case 'ask': case '問':
      // 有 WebSearch.gs 就用會上網查的版本，沒有就退回 Llm.gs 的一般版
      if (typeof llmChatWeb_ === 'function') llmChatWeb_(arg, ev);
      else llmChat_(arg, ev);
      return;

    case 'summary': case 'sum': case '摘要':
      summaryCmd_(arg, ev);
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
    '  /ask 問題          自由對話，會記得前幾輪；需要時會上網查並附來源',
    '  /ask clear        清掉對話記憶',
    '  /summary          摘要這個群組今天的對話',
    '  /summary 3        摘要最近 3 天（私訊要先 /use 選專案）',
    '',
    '【專案】一個 bot 可以同時服務多個群組',
    '  /where            目前用的是哪個看板',
    '  /use              私訊切換專案（先打 /use 看清單）',
    '  /setup 看板網址     把這個群組綁到看板（限管理員）',
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

/**
 * 清單開頭標出專案名稱 —— 只在綁定了群組專案之後才顯示。
 * 只有一個看板時標出來只是雜訊；有多個時不標，就分不清眼前是哪一邊的卡。
 */
function projectHeader_() {
  if (!allProjects_().length) return '';
  return '專案：' + projectOf_(CURRENT_EV).name + '\n\n';
}

function renderOpenCards_() {
  var cards = openCards_();
  if (!cards.length) return projectHeader_() + '目前沒有未結案的卡片。\n（/list all 可以看含已解決的全部）';

  return projectHeader_() + renderCards_(cards, ['待確認', '處理中', '等回覆']) +
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

/**
 * 「目前這張卡」存在指令碼屬性，不是 CacheService。
 *
 * CacheService 是 best-effort 的，平台隨時可以把資料清掉，實測就遇過
 * /show 之後緊接著傳圖卻查不到的情況。這是使用者流程的關鍵狀態，
 * 不能建立在允許遺失的儲存上。屬性是永續的，過期由我們自己算。
 */
var LASTCARD_TTL = 1800;   // 秒；超過就當作沒指定

function lastCardKey_(ev) {
  var uid = ev.source && ev.source.userId;
  return uid ? 'LASTCARD_' + uid : null;
}

function rememberCard_(ev, card) {
  var key = lastCardKey_(ev);
  if (!key || !card) return;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
    id: card.id, idShort: card.idShort, name: card.name, url: card.url,
    at: Math.floor(new Date().getTime() / 1000)
  }));
  trace_('[記住] 目前卡片 #' + card.idShort + '　' + key);
}

function lastCard_(ev) {
  var key = lastCardKey_(ev);
  if (!key) return null;

  var P = PropertiesService.getScriptProperties();
  var raw = P.getProperty(key);
  if (!raw) {
    trace_('[目前卡片] 沒有紀錄　' + key);
    return null;
  }

  var card;
  try {
    card = JSON.parse(raw);
  } catch (err) {
    P.deleteProperty(key);
    return null;
  }

  var age = Math.floor(new Date().getTime() / 1000) - (card.at || 0);
  if (age > LASTCARD_TTL) {
    trace_('[目前卡片] #' + card.idShort + ' 已過期（' + age + ' 秒）');
    P.deleteProperty(key);
    return null;
  }

  card.age = age;
  return card;
}

/** 印出目前記住的卡片，直接看狀態，不必透過 LINE 來回試 */
function showLastCard() {
  var raw = PropertiesService.getScriptProperties().getProperty('LAST_EVENT');
  if (!raw) { console.log('還沒有收到任何 LINE 事件。'); return; }

  var uid;
  try {
    uid = JSON.parse(JSON.parse(raw).body).events[0].source.userId;
  } catch (err) {
    console.log('無法從 LAST_EVENT 取出 userId：' + err);
    return;
  }

  var val = PropertiesService.getScriptProperties().getProperty('LASTCARD_' + uid);
  if (!val) {
    console.log('userId ' + uid + ' 目前沒有記住任何卡片。\n' +
      '→ 先在 LINE 打 /show <編號> 或開一張單，再跑一次這個函式。');
    return;
  }

  var c = JSON.parse(val);
  var age = Math.floor(new Date().getTime() / 1000) - (c.at || 0);
  console.log('userId: ' + uid +
    '\n目前卡片: ' + c.idShort + '. ' + c.name +
    '\n記錄於: ' + age + ' 秒前' +
    (age > LASTCARD_TTL ? '　← 已超過 ' + LASTCARD_TTL + ' 秒，視為過期'
                        : '　（私訊有效；群組限 ' + GROUP_IMAGE_WINDOW + ' 秒內）') +
    '\n' + c.url);
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
    trace_('[圖片] 私訊但查不到目前卡片');
    reply_(ev.replyToken,
      '還沒有指定卡片，這張圖沒有收。\n\n' +
      '先開單：#問題描述\n' +
      '或指定一張現有的：/show 編號\n' +
      '指定後 30 分鐘內傳的圖都會附到那張卡。');
    return;
  }

  trace_('[圖片] 目標 #' + card.idShort + '（' + (card.age || 0) + ' 秒前指定）');

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
