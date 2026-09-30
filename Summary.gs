/**
 * /summary —— 摘要群組對話
 *
 * 資料來源是 Archive.gs 寫的「LINE 對話紀錄（原始）」試算表（log 分頁），
 * 用「對話ID」欄篩出同一個群組的訊息，再交給 LLM 摘要。
 *
 *   群組裡 @@@/summary     摘要這個群組今天的對話
 *   群組裡 @@@/summary 3   摘要這個群組最近 3 天
 *   私訊   /summary        摘要 /use 選的專案所綁定的群組（限該群組成員）
 *
 * 需要 LLM 層（OPENAI_REFRESH_TOKEN）與存檔（ARCHIVE_SHEET_ID）都已設定。
 * bot 自己的回覆不會被存檔，所以摘要只涵蓋成員的發言。
 */

var SUMMARY_MAX_DAYS  = 14;      // 一次最多摘要幾天
var SUMMARY_SCAN_ROWS = 5000;    // 只掃試算表最後幾列，避免整張表越長越慢
var SUMMARY_MAX_CHARS = 40000;   // 送給模型的逐字稿上限；超過就保留最新的部分

/* 試算表欄位位置（對應 ARCHIVE_HEADERS） */
var COL_TIME = 0, COL_CHAT = 2, COL_CHATNAME = 3, COL_SENDER = 5, COL_TYPE = 6, COL_TEXT = 7;

function summaryCmd_(arg, ev) {
  if (!llmEnabled_()) {
    reply_(ev.replyToken, '摘要需要 AI 功能，目前沒有啟用（指令碼屬性 OPENAI_REFRESH_TOKEN 未設定）。');
    return;
  }

  var sheetId = PropertiesService.getScriptProperties().getProperty('ARCHIVE_SHEET_ID');
  if (!sheetId) {
    reply_(ev.replyToken, '對話存檔還沒啟用，沒有資料可以摘要。\n管理員請在 Apps Script 執行一次 setupArchive。');
    return;
  }

  var days = parseSummaryDays_(arg);
  if (days === null) {
    reply_(ev.replyToken, '天數要是 1 到 ' + SUMMARY_MAX_DAYS + ' 的數字，例如：\n/summary　　今天\n/summary 3　最近 3 天');
    return;
  }

  var target = summaryTarget_(ev);
  if (target.error) {
    reply_(ev.replyToken, target.error);
    return;
  }

  var data = loadTranscript_(sheetId, target.chatId, days);
  var rangeLabel = days === 1 ? '今天' : '最近 ' + days + ' 天';
  var name = data.chatName || target.name || '這個群組';

  if (!data.lines.length) {
    reply_(ev.replyToken, name + ' ' + rangeLabel + '沒有可以摘要的對話。');
    return;
  }

  trace_('[summary] ' + target.chatId + ' ' + rangeLabel + ' ' + data.lines.length + ' 則');

  var transcript = data.lines.join('\n');
  var truncated = false;
  if (transcript.length > SUMMARY_MAX_CHARS) {
    transcript = transcript.slice(transcript.length - SUMMARY_MAX_CHARS);
    transcript = transcript.slice(transcript.indexOf('\n') + 1);   // 不要從一行中間開始
    truncated = true;
  }

  var instructions = [
    '你要幫一個工作群組摘要 LINE 對話。以下每一行是「時間 發言人：內容」。',
    '',
    '輸出格式（LINE 不支援 Markdown，不要用 **、#、表格；條列用「- 」開頭）：',
    '',
    '重點討論',
    '- 依主題歸納，不要照時間流水帳',
    '',
    '決議',
    '- 明確講定的事；沒有就寫「沒有明確決議」',
    '',
    '待辦',
    '- 誰要做什麼、什麼時候；負責人不明確就標「（負責人未定）」',
    '',
    '未解問題',
    '- 有人問了但還沒得到答案的；沒有就省略這一段',
    '',
    '規則：',
    '- 用繁體中文、台灣用語，總長控制在 600 字內',
    '- 只根據對話內容，不要推測或補充對話裡沒有的資訊',
    '- 標有「（開單）」的是有人透過 bot 建立了追蹤卡片的問題',
    truncated ? '- 對話太長，較早的部分已省略，摘要開頭要註明只涵蓋後段' : ''
  ].join('\n');

  var answer;
  try {
    answer = llmAsk_(instructions, transcript);
  } catch (err) {
    trace_('[summary] LLM 失敗: ' + err);
    reply_(ev.replyToken, '摘要的時候出錯了。\n' + String(err).slice(0, 200));
    return;
  }

  answer = (answer || '').trim();
  if (!answer) {
    reply_(ev.replyToken, '沒有拿到摘要結果，再試一次看看。');
    return;
  }

  var header = '【摘要】' + name + '・' + rangeLabel + '（' + data.lines.length + ' 則）';
  var text = header + '\n\n' + answer;
  if (text.length > 4800) text = text.slice(0, 4800) + '\n…（後面省略）';
  reply_(ev.replyToken, text);
}

/** 空白 → 1（今天）；1..MAX 的數字 → 該天數；其他 → null */
function parseSummaryDays_(arg) {
  var s = (arg || '').trim();
  if (!s || /^(today|今天)$/i.test(s)) return 1;
  if (!/^\d+$/.test(s)) return null;
  var n = parseInt(s, 10);
  return (n >= 1 && n <= SUMMARY_MAX_DAYS) ? n : null;
}

/**
 * 決定要摘要哪個對話。
 *
 * 私訊不屬於任何群組，只能靠 /use 指定。這裡一定要檢查成員身分：
 * /use 誰都能切，不檢查的話任何人都能私訊 bot 摘要自己不在的群組。
 */
function summaryTarget_(ev) {
  var src = ev.source || {};
  var gid = src.groupId || src.roomId;
  if (gid) return { chatId: gid };

  var use = PropertiesService.getScriptProperties().getProperty('USE_' + src.userId);
  var project = loadProject_(use);
  if (!project) {
    return { error: '私訊摘要要先用 /use 選一個專案，bot 才知道要摘要哪個群組。\n' +
                    '（還沒 /setup 的群組不會出現在 /use 清單裡）' };
  }

  if (!isChatMember_(project.key, src.userId)) {
    return { error: '你不在「' + project.name + '」綁定的那個群組裡，不能摘要它的對話。' };
  }

  return { chatId: project.key, name: project.groupName || project.name };
}

/** 用 LINE API 查某人是不是群組／多人聊天室的成員（groupId 以 C 開頭，roomId 以 R 開頭） */
function isChatMember_(chatId, userId) {
  if (!chatId || !userId) return false;
  var kind = chatId.charAt(0) === 'R' ? 'room' : 'group';
  var res = UrlFetchApp.fetch(
    'https://api.line.me/v2/bot/' + kind + '/' + chatId + '/member/' + userId,
    { headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
      muteHttpExceptions: true });
  return res.getResponseCode() === 200;
}

/**
 * 從存檔試算表讀出某個對話在時間範圍內的訊息，整理成逐字稿。
 *
 * 時間欄是 Archive.gs 以 'yyyy-MM-dd HH:mm:ss' 寫入的字串，
 * 同格式字串可以直接比大小，不必轉成 Date。
 */
function loadTranscript_(sheetId, chatId, days) {
  var sh = SpreadsheetApp.openById(sheetId).getSheetByName('log');
  var last = sh.getLastRow();
  if (last < 2) return { lines: [], chatName: null };

  var start = Math.max(2, last - SUMMARY_SCAN_ROWS + 1);
  var rows = sh.getRange(start, 1, last - start + 1, ARCHIVE_HEADERS.length).getDisplayValues();

  var cutoffDay = new Date(new Date().getTime() - (days - 1) * 86400000);
  var cutoff = Utilities.formatDate(cutoffDay, ARCHIVE_TZ, 'yyyy-MM-dd') + ' 00:00:00';

  var lines = [];
  var chatName = null;

  rows.forEach(function (r) {
    if (r[COL_CHAT] !== chatId) return;
    if (String(r[COL_TIME]) < cutoff) return;
    if (r[COL_TYPE] === 'sticker') return;

    chatName = r[COL_CHATNAME] || chatName;

    var text = String(r[COL_TEXT]).replace(/^'/, '');   // 去掉 Archive.gs 防公式加的單引號

    // 叫 bot 的指令（@@@/list、/done 5…）是操作不是討論，略過；
    // @@@ 開頭但不是指令的是開單，保留下來並標註
    if (/^[@＠]{3}\s*\//.test(text) || /^\//.test(text)) return;
    if (/^[@＠]{3}/.test(text)) text = text.replace(/^[@＠]{3}\s*/, '') + '（開單）';

    lines.push(String(r[COL_TIME]).slice(5, 16) + ' ' + r[COL_SENDER] + '：' + text.replace(/\n/g, ' / '));
  });

  return { lines: lines, chatName: chatName };
}

/* ========== 測試 ========== */

/**
 * 在編輯器裡乾跑：印出某個群組今天會被送去摘要的逐字稿，不呼叫 LLM。
 * 群組 ID 從 LAST_EVENT 取（先在那個群組講一句話再跑）。
 */
function testSummaryTranscript() {
  var raw = PropertiesService.getScriptProperties().getProperty('LAST_EVENT');
  var chatId;
  try {
    var src = JSON.parse(JSON.parse(raw).body).events[0].source;
    chatId = src.groupId || src.roomId || src.userId;
  } catch (err) {
    console.log('無法從 LAST_EVENT 取得對話 ID，先在群組裡講一句話再跑。');
    return;
  }
  var sheetId = PropertiesService.getScriptProperties().getProperty('ARCHIVE_SHEET_ID');
  var data = loadTranscript_(sheetId, chatId, 1);
  console.log('對話：' + (data.chatName || chatId) + '　今天共 ' + data.lines.length + ' 則\n\n' +
    data.lines.slice(-50).join('\n'));
}
