/**
 * シートの読み書き・設定・ログ・ロックの共通部品。
 */

function getBook() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheetOrThrow(name) {
  var sheet = getBook().getSheetByName(name);
  if (!sheet) throw new Error('シート「' + name + '」がありません。setupSheets を実行してください。');
  return sheet;
}

/**
 * シートを見出し付きの表として読む。
 * @return {{sheet, headers: string[], rows: Array<Array>, col: function(string): number}}
 *   rows は2行目以降。col(見出し) は0始まりの列位置（なければ例外）。
 */
function readTable(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var values = lastRow > 0 && lastCol > 0 ? sheet.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
  var headers = values[0].map(function (h) { return String(h).trim(); });
  return {
    sheet: sheet,
    headers: headers,
    rows: values.slice(1),
    col: function (name) {
      var idx = headers.indexOf(name);
      if (idx === -1) throw new Error('シート「' + sheet.getName() + '」に列「' + name + '」がありません。');
      return idx;
    },
  };
}

/** 表の1行を {見出し: 値} にする */
function rowToObject(table, row) {
  var obj = {};
  table.headers.forEach(function (h, i) { if (h) obj[h] = row[i]; });
  return obj;
}

/** {見出し: 値} を表の列順の配列にする（ない列は空） */
function objectToRow(table, obj) {
  return table.headers.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
}

/** 足りない見出しを右端に追加する。追加後の表を返す。 */
function ensureHeaders(sheet, headers) {
  var table = readTable(sheet);
  var missing = headers.filter(function (h) { return table.headers.indexOf(h) === -1; });
  if (missing.length === 0) return table;
  var start = table.headers.filter(function (h) { return h !== ''; }).length + 1;
  if (sheet.getMaxColumns() < start + missing.length - 1) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), start + missing.length - 1 - sheet.getMaxColumns());
  }
  sheet.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
  return readTable(sheet);
}

/**
 * 表の2行目以降を rows で書き直す（行が減った分は消す）。
 * textColumns の列は先頭の0が消えないよう書式なしテキストにする。
 */
function writeTableRows(table, rows, textColumns) {
  var sheet = table.sheet;
  var width = table.headers.length;
  var oldCount = table.rows.length;
  if (rows.length > 0) {
    setTextFormat_(table, 2, rows.length, textColumns);
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  }
  if (oldCount > rows.length) {
    sheet.getRange(2 + rows.length, 1, oldCount - rows.length, width).clearContent();
  }
  table.rows = rows;
}

/** 表の末尾に行を追加する */
function appendTableRows(table, rows, textColumns) {
  if (rows.length === 0) return;
  var startRow = table.rows.length + 2;
  setTextFormat_(table, startRow, rows.length, textColumns);
  table.sheet.getRange(startRow, 1, rows.length, table.headers.length).setValues(rows);
  table.rows = table.rows.concat(rows);
}

function setTextFormat_(table, startRow, numRows, textColumns) {
  // シートの行数を超えて書くとエラーになるので、足りなければ行を足す
  var need = startRow + numRows - 1 - table.sheet.getMaxRows();
  if (need > 0) table.sheet.insertRowsAfter(table.sheet.getMaxRows(), need);
  (textColumns || []).forEach(function (name) {
    var idx = table.headers.indexOf(name);
    if (idx !== -1) table.sheet.getRange(startRow, idx + 1, numRows, 1).setNumberFormat('@');
  });
}

/**
 * 設定シートを読む。
 * @return {{get: function(string): *, courseMap: Object<string, string>}}
 */
function getSettings() {
  var sheet = getSheetOrThrow(SHEET.SETTINGS);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var kv = {};
  sheet.getRange(1, 1, lastRow, 2).getValues().forEach(function (r) {
    var key = String(r[0]).trim();
    if (key) kv[key] = r[1];
  });
  var courseMap = {};
  sheet.getRange(2, COURSE_MAP_COLUMN, Math.max(lastRow - 1, 1), 2).getValues().forEach(function (r) {
    var product = String(r[0]).trim();
    var course = String(r[1]).trim();
    if (product && course) courseMap[product] = course;
  });
  return {
    get: function (key) { return kv.hasOwnProperty(key) ? kv[key] : ''; },
    courseMap: courseMap,
  };
}

/** ログシートと実行ログの両方に書く */
function writeLog(process, level, message) {
  console.log('[' + process + '][' + level + '] ' + message);
  try {
    var sheet = getBook().getSheetByName(SHEET.LOG);
    if (!sheet) return;
    sheet.appendRow([new Date(), process, level, String(message)]);
    var over = sheet.getLastRow() - 1 - LOG_MAX_ROWS;
    if (over > 0) sheet.deleteRows(2, over);
  } catch (e) {
    console.error('ログの書き込みに失敗: ' + e);
  }
}

/** フォーム送信と夜間処理が同時に書き込まないよう、スクリプト全体でロックして実行する */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5 * 60 * 1000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** フォーム回答の行から、候補名の列の値を取る */
function pickField(headers, row, candidates) {
  var idx = findColumn(headers, candidates);
  return idx === -1 ? '' : row[idx];
}
