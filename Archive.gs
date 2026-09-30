/**
 * LINE 對話存檔
 *
 * 每則收到的訊息（不論有沒有 @bot）都 appendRow 進一張 Google Sheet，
 * 每小時再把「本月＋上月」的紀錄匯出成 Markdown，一個對話一個月一個檔，
 * 放在 Drive 的「LINE 對話紀錄」資料夾 -- 同步到本機後 agent 直接讀檔。
 *
 * 第一次使用：手動執行 setupArchive() 一次（會要求 Sheets / Drive 權限）。
 * 存檔失敗只寫 trace，不會影響 Trello 開單流程。
 */

var ARCHIVE_TZ = 'Asia/Taipei';
var ARCHIVE_HEADERS = ['時間', '來源類型', '對話ID', '對話名稱', 'userId', '發言人', '訊息類型', '內容', 'messageId'];

/* ========== 寫入 ========== */

function archiveEvent_(ev) {
  var sheetId = PropertiesService.getScriptProperties().getProperty('ARCHIVE_SHEET_ID');
  if (!sheetId) return; // 還沒跑 setupArchive，靜默略過

  var src = ev.source || {};
  var chatId = src.groupId || src.roomId || src.userId || '';
  var sender = cachedSenderName_(ev);

  var row = [
    Utilities.formatDate(new Date(ev.timestamp || Date.now()), ARCHIVE_TZ, 'yyyy-MM-dd HH:mm:ss'),
    src.type || '',
    chatId,
    chatName_(src, sender),
    src.userId || '',
    sender,
    ev.message.type,
    messageContent_(ev.message),
    ev.message.id || ''
  ];
  // 前置單引號：避免內容以 = + - @ 開頭時被 Sheet 當成公式
  row[7] = /^[=+\-@]/.test(row[7]) ? "'" + row[7] : row[7];

  SpreadsheetApp.openById(sheetId).getSheetByName('log').appendRow(row);
  trace_('[存檔] ' + row[3] + ' / ' + sender);
}

function messageContent_(m) {
  switch (m.type) {
    case 'text':     return m.text || '';
    case 'image':    return '[圖片]';
    case 'video':    return '[影片]';
    case 'audio':    return '[語音]';
    case 'file':     return '[檔案] ' + (m.fileName || '');
    case 'sticker':  return '[貼圖]';
    case 'location': return '[位置] ' + [m.title, m.address].filter(Boolean).join(' ');
    default:         return '[' + m.type + ']';
  }
}

/** senderName_ 每次都打 API；存檔每則訊息都要用，所以加 6 小時快取 */
function cachedSenderName_(ev) {
  var src = ev.source || {};
  if (!src.userId) return '未知成員';
  var cache = CacheService.getScriptCache();
  var k = 'name_' + (src.groupId || src.roomId || '') + '_' + src.userId;
  var name = cache.get(k);
  if (name) return name;
  name = senderName_(ev);
  if (name !== '未知成員') cache.put(k, name, 21600);
  return name;
}

function chatName_(src, sender) {
  if (src.type === 'user') return '私訊-' + sender;
  if (src.type === 'room') return '多人聊天室-' + String(src.roomId).slice(-6);

  var cache = CacheService.getScriptCache();
  var k = 'gname_' + src.groupId;
  var name = cache.get(k);
  if (name) return name;

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + src.groupId + '/summary', {
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });
  name = res.getResponseCode() === 200
    ? JSON.parse(res.getContentText()).groupName
    : '群組-' + String(src.groupId).slice(-6);
  cache.put(k, name, 21600);
  return name;
}

/* ========== 匯出成 Markdown ========== */

/** 每小時由觸發器呼叫；只重寫本月與上月的檔案，舊月份不動 */
function exportArchive() {
  var props = PropertiesService.getScriptProperties();
  var sheet = SpreadsheetApp.openById(props.getProperty('ARCHIVE_SHEET_ID')).getSheetByName('log');
  var folder = DriveApp.getFolderById(props.getProperty('ARCHIVE_FOLDER_ID'));

  var now = new Date();
  var thisMonth = Utilities.formatDate(now, ARCHIVE_TZ, 'yyyy-MM');
  var lastMonth = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 15), ARCHIVE_TZ, 'yyyy-MM');

  var rows = sheet.getDataRange().getDisplayValues().slice(1);
  var groups = {}; // chatId|month -> { name, rows }
  rows.forEach(function (r) {
    var month = r[0].slice(0, 7);
    if (month !== thisMonth && month !== lastMonth) return;
    var key = r[2] + '|' + month;
    if (!groups[key]) groups[key] = { chatId: r[2], month: month, rows: [] };
    groups[key].name = r[3]; // 用最新的名稱（群組改名後跟著改）
    groups[key].rows.push(r);
  });

  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    var fileName = safeFileName_(g.name) + ' (' + g.chatId.slice(-6) + ') ' + g.month + '.md';
    writeOrReplace_(folder, g.chatId + '|' + g.month, fileName, renderMarkdown_(g));
  });
}

function renderMarkdown_(g) {
  var out = ['# ' + g.name + ' — ' + g.month, ''];
  var day = '';
  g.rows.forEach(function (r) {
    var d = r[0].slice(0, 10);
    if (d !== day) { out.push('', '## ' + d, ''); day = d; }
    var body = String(r[7]).replace(/^'/, '').replace(/\n/g, '\n  ');
    out.push('- ' + r[0].slice(11, 16) + ' **' + r[5] + '**：' + body);
  });
  return out.join('\n') + '\n';
}

/**
 * chatId|month -> fileId 存在指令碼屬性裡（Drive 搜尋語法不能查 description）。
 * 群組改名時會連檔名一起更新，不會產生第二個檔。
 */
function writeOrReplace_(folder, key, fileName, content) {
  var props = PropertiesService.getScriptProperties();
  var pk = 'ARCHIVE_FILE_' + key;
  var id = props.getProperty(pk);
  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) {
        f.setContent(content);
        if (f.getName() !== fileName) f.setName(fileName);
        return;
      }
    } catch (err) { /* 檔案被刪了，重建 */ }
  }
  props.setProperty(pk, folder.createFile(fileName, content, MimeType.PLAIN_TEXT).getId());
}

function safeFileName_(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/* ========== 一次性設定 ========== */

/** 手動執行一次：建立 Sheet、Drive 資料夾、每小時匯出觸發器 */
function setupArchive() {
  var props = PropertiesService.getScriptProperties();

  if (!props.getProperty('ARCHIVE_SHEET_ID')) {
    var ss = SpreadsheetApp.create('LINE 對話紀錄（原始）');
    var sh = ss.getSheets()[0].setName('log');
    sh.appendRow(ARCHIVE_HEADERS);
    sh.setFrozenRows(1);
    props.setProperty('ARCHIVE_SHEET_ID', ss.getId());
  }
  if (!props.getProperty('ARCHIVE_FOLDER_ID')) {
    props.setProperty('ARCHIVE_FOLDER_ID', DriveApp.createFolder('LINE 對話紀錄').getId());
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'exportArchive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('exportArchive').timeBased().everyHours(1).create();

  console.log('Sheet：https://docs.google.com/spreadsheets/d/' + props.getProperty('ARCHIVE_SHEET_ID'));
  console.log('資料夾：https://drive.google.com/drive/folders/' + props.getProperty('ARCHIVE_FOLDER_ID'));
  console.log('每小時匯出觸發器已建立。資料夾可以自由搬移到同步範圍內，ID 不會變。');
}
