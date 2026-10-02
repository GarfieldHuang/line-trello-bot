/**
 * /stats —— 每天新增與解決幾張卡
 *
 *   /stats       最近 7 天
 *   /stats 30    最近 30 天（最多 31）
 *
 * 資料來自 Trello 看板的動作歷史（createCard 與移動清單的 updateCard），
 * 不論是透過 LINE 的 /done 還是直接在 Trello 拖曳都會被算到。
 * 群組用它綁定的看板；私訊用 /use 選的專案（沒選就是預設看板）。
 *
 * 計算規則：
 *   新增  當天建立的卡片
 *   解決  當天被移進「已解決」，而且當天結束時還在「已解決」
 *   重開  當天從「已解決」被移出去，而且當天結束時不在「已解決」
 *
 * 同一張卡同一天只看最後的狀態，來回拖幾次都只算一次 ——
 * 否則一張卡在已解決進進出出，會被重複算成好幾張。
 *
 * 看不出「誰」解決的：bot 所有操作都用同一把 Trello token，動作作者都是同一個人。
 */

var STATS_DEFAULT_DAYS = 7;
var STATS_MAX_DAYS = 31;
var WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

function statsCmd_(arg, ev) {
  var s = (arg || '').trim();
  var days = STATS_DEFAULT_DAYS;
  if (s) {
    if (!/^\d+$/.test(s) || +s < 1 || +s > STATS_MAX_DAYS) {
      reply_(ev.replyToken, '天數要在 1 到 ' + STATS_MAX_DAYS + ' 之間，例如：\n/stats\n/stats 30');
      return;
    }
    days = parseInt(s, 10);
  }

  var project = projectOf_(ev);
  var L = project.lists;
  if (!L.todo || !L.done) {
    reply_(ev.replyToken, '這個專案的清單還沒設定好（群組請先 /setup）。');
    return;
  }

  var result;
  try {
    result = computeStats_(L, days);
  } catch (err) {
    trace_('[stats] 失敗: ' + err);
    reply_(ev.replyToken, '讀取 Trello 歷史時出錯了。\n' + String(err).slice(0, 200));
    return;
  }

  var openNow = 0;
  try { openNow = openCards_().length; } catch (err) { openNow = -1; }

  reply_(ev.replyToken, renderStats_(project.name, days, result, openNow));
}

/**
 * 回傳 { daysList:[{date, label, created, resolved, reopened}], totals, truncated }
 * date 為台灣時間 yyyy-MM-dd，由舊到新排列，範圍內每一天都有一筆（沒動靜的日子也列出）。
 */
function computeStats_(L, days) {
  var boardId = trelloGet_('/lists/' + L.todo, { fields: 'idBoard' }).idBoard;

  var now = new Date();
  var startDate = Utilities.formatDate(new Date(now.getTime() - (days - 1) * 86400000), 'Asia/Taipei', 'yyyy-MM-dd');
  // since 用 UTC；往前多抓一天，最後再用台灣日期過濾，避免時區邊界漏掉資料
  var since = new Date(now.getTime() - days * 86400000).toISOString();

  var actions = trelloGet_('/boards/' + boardId + '/actions', {
    filter: 'createCard,updateCard:idList',
    since: since,
    limit: 1000,
    fields: 'type,date,data'
  });

  var buckets = {};
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(now.getTime() - i * 86400000);
    var key = Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
    buckets[key] = {
      date: key,
      label: key.slice(5) + ' ' + WEEKDAY_ZH[parseInt(Utilities.formatDate(d, 'Asia/Taipei', 'u'), 10) % 7],
      created: 0, resolved: 0, reopened: 0
    };
  }

  // Trello 回傳新到舊；由舊到新處理，「最後狀態」才會是當天最後一個動作
  var sorted = actions.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  var createdSeen = {};
  var lastDoneMove = {};   // 'date|cardId' -> true（最後一次是移進已解決）/ false（移出）

  sorted.forEach(function (a) {
    var day = Utilities.formatDate(new Date(a.date), 'Asia/Taipei', 'yyyy-MM-dd');
    if (!buckets[day] || !a.data || !a.data.card) return;
    var cardId = a.data.card.id;

    if (a.type === 'createCard') {
      if (!createdSeen[cardId]) { createdSeen[cardId] = true; buckets[day].created++; }
      return;
    }

    var after = a.data.listAfter && a.data.listAfter.id;
    var before = a.data.listBefore && a.data.listBefore.id;
    if (after === L.done) lastDoneMove[day + '|' + cardId] = true;
    else if (before === L.done) lastDoneMove[day + '|' + cardId] = false;
  });

  Object.keys(lastDoneMove).forEach(function (k) {
    var day = k.split('|')[0];
    if (lastDoneMove[k]) buckets[day].resolved++;
    else buckets[day].reopened++;
  });

  var list = Object.keys(buckets).sort().map(function (k) { return buckets[k]; })
    .filter(function (b) { return b.date >= startDate; });

  var totals = list.reduce(function (t, b) {
    t.created += b.created; t.resolved += b.resolved; t.reopened += b.reopened; return t;
  }, { created: 0, resolved: 0, reopened: 0 });

  return { daysList: list, totals: totals, truncated: actions.length >= 1000 };
}

function renderStats_(name, days, r, openNow) {
  var out = ['【統計】' + name + '・最近 ' + days + ' 天', ''];

  r.daysList.forEach(function (b) {
    var bar = b.resolved ? ' ' + new Array(Math.min(b.resolved, 15) + 1).join('▇') : '';
    out.push(b.label + '　新增 ' + b.created + '　解決 ' + b.resolved +
      (b.reopened ? '　重開 ' + b.reopened : '') + bar);
  });

  out.push('');
  out.push('合計　新增 ' + r.totals.created + '　解決 ' + r.totals.resolved +
    (r.totals.reopened ? '　重開 ' + r.totals.reopened : ''));
  if (openNow >= 0) out.push('目前未結案 ' + openNow + ' 張');
  if (r.truncated) out.push('（動作超過 1000 筆，較早的資料可能沒算到，請縮短天數）');

  return out.join('\n');
}

/** 在編輯器乾跑：印出預設看板最近 7 天的統計 */
function testStats() {
  var p = defaultProject_();
  console.log(renderStats_(p.name, 7, computeStats_(p.lists, 7), openCards_().length));
}
