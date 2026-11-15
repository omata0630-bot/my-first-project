/**
 * 初期設定。スプレッドシートを開くと「サロン管理」メニューが出る。
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('サロン管理')
    .addItem('いますぐ取込・突合を実行', 'nightlyImport')
    .addItem('検索用ファイルを更新', 'updateSearchSheet')
    .addSeparator()
    .addItem('初期設定：シートを作る', 'setupSheets')
    .addItem('初期設定：トリガーを登録', 'installTriggers')
    .addItem('初期設定：過去データを移行', 'migrateLegacy')
    .addItem('突合の精度を確認', 'reportMatchAccuracy')
    .addToUi();
}

/** 必要なシートと見出しを作る。何度実行しても既存のデータは消さない。 */
function setupSheets() {
  var book = getBook();
  var ensureSheet = function (name, headers) {
    var sheet = book.getSheetByName(name) || book.insertSheet(name);
    ensureHeaders(sheet, headers);
    sheet.setFrozenRows(1);
    return sheet;
  };
  var visits = ensureSheet(SHEET.VISITS, HEADERS.VISITS);
  ensureSheet(SHEET.SALES, HEADERS.SALES);
  ensureSheet(SHEET.CUSTOMERS, HEADERS.CUSTOMERS);
  ensureSheet(SHEET.LOG, HEADERS.LOG);

  // 突合ステータスは選択式にして、入力ミスを防ぐ
  var statusCol = readTable(visits).col('突合ステータス') + 1;
  visits.getRange(2, statusCol, visits.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS.UNMATCHED, STATUS.AUTO_UNIQUE, STATUS.AUTO_ORDER, STATUS.NEEDS_REVIEW, STATUS.MANUAL, STATUS.MIGRATED], true)
      .setAllowInvalid(false)
      .build());

  setupSettingsSheet_(book);

  var notes = [];
  [SHEET.COUNSELING, SHEET.RESERVATION].forEach(function (name) {
    if (!book.getSheetByName(name)) notes.push('「' + name + '」がありません。フォームの回答シートの名前をこの名前に変えてください（予約フォームがなければ不要）。');
  });
  writeLog('setupSheets', 'INFO', '完了。' + notes.join(' '));
  if (notes.length > 0) SpreadsheetApp.getUi().alert(notes.join('\n'));
}

function setupSettingsSheet_(book) {
  var sheet = book.getSheetByName(SHEET.SETTINGS);
  if (sheet) return; // 店長が書き換えた値を消さない
  sheet = book.insertSheet(SHEET.SETTINGS);
  var rows = [['項目', '値', '説明']].concat(SETTING_DEFAULTS);
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange(1, COURSE_MAP_COLUMN, 1, 2).setValues([COURSE_MAP_HEADER]);
  sheet.getRange(1, 1, 1, COURSE_MAP_COLUMN + 1).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(3, 360);
  sheet.setColumnWidth(COURSE_MAP_COLUMN, 220);
  sheet.setColumnWidth(COURSE_MAP_COLUMN + 1, 220);
}

/** フォーム送信時・毎日2時のトリガーを登録する（既存の同じトリガーは作り直す） */
function installTriggers() {
  var handlers = ['onFormSubmitRouter', 'nightlyImport'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmitRouter').forSpreadsheet(getBook()).onFormSubmit().create();
  ScriptApp.newTrigger('nightlyImport').timeBased().everyDays(1).atHour(2).create();
  writeLog('installTriggers', 'INFO', 'トリガーを登録しました');
}
