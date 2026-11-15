/**
 * 顧客台帳の再集計と、バイト用の検索ファイルの更新。
 */

/** 来店記録を {customerId, datetime, course, amount} の配列で読む */
function loadVisitsForAggregate_() {
  var t = readTable(getSheetOrThrow(SHEET.VISITS));
  return t.rows.map(function (r) {
    return {
      customerId: normalizePhone(r[t.col('顧客ID')]),
      datetime: parseDateTime(r[t.col('来店日時')]),
      course: r[t.col('コース')],
      amount: r[t.col('金額')],
    };
  });
}

/**
 * 来店記録から顧客台帳を作り直す。
 * 行の並びと、台帳に後から足した列（メモなど）はそのまま残す。
 * @param {Object<string, string>} [names] 顧客ID → 氏名（新しく分かった氏名で上書きする）
 */
function rebuildCustomers(names) {
  names = names || {};
  var agg = aggregateCustomers(loadVisitsForAggregate_());
  var t = readTable(getSheetOrThrow(SHEET.CUSTOMERS));
  var c = {
    id: t.col('顧客ID'), name: t.col('氏名'), first: t.col('初回来店日'), last: t.col('最終来店日'),
    count: t.col('来店回数'), total: t.col('累計売上'), course: t.col('前回コース'),
  };

  var seen = {};
  var rows = t.rows.filter(function (r) { return String(r[c.id]) !== ''; }).map(function (r) {
    var id = normalizePhone(r[c.id]);
    seen[id] = true;
    r[c.id] = id;
    applyAggregate_(r, c, agg[id], names[id]);
    return r;
  });
  Object.keys(agg).forEach(function (id) {
    if (seen[id]) return;
    var r = t.headers.map(function () { return ''; });
    r[c.id] = id;
    applyAggregate_(r, c, agg[id], names[id]);
    rows.push(r);
  });
  writeTableRows(t, rows, TEXT_COLUMNS.CUSTOMERS);
  return agg;
}

function applyAggregate_(row, c, a, name) {
  if (name) row[c.name] = name;
  row[c.first] = a ? a.first : '';
  row[c.last] = a ? a.last : '';
  row[c.count] = a ? a.count : 0;
  row[c.total] = a ? a.total : 0;
  row[c.course] = a ? a.lastCourse : '';
}

/**
 * 検索用スプレッドシート（バイトに共有するファイル）を更新する。
 * 設定「検索用に出す列」の列だけをコピーする。カウンセリング内容は含めない。
 */
function updateSearchSheet() {
  var settings = getSettings();
  var fileId = String(settings.get(SETTING_KEYS.SEARCH_SPREADSHEET_ID)).trim();
  if (!fileId) {
    writeLog('updateSearchSheet', 'WARN', '検索用スプレッドシートIDが未設定のためスキップ');
    return;
  }
  var columns = splitList(settings.get(SETTING_KEYS.SEARCH_COLUMNS));
  var t = readTable(getSheetOrThrow(SHEET.CUSTOMERS));
  var idx = columns.map(function (name) { return t.col(name); });
  var data = [columns].concat(t.rows
    .filter(function (r) { return String(r[t.col('顧客ID')]) !== ''; })
    .map(function (r) { return idx.map(function (i) { return r[i]; }); }));

  var sheet = SpreadsheetApp.openById(fileId).getSheets()[0];
  sheet.clearContents();
  var idCol = columns.indexOf('顧客ID');
  if (idCol !== -1) sheet.getRange(1, idCol + 1, data.length, 1).setNumberFormat('@');
  sheet.getRange(1, 1, data.length, columns.length).setValues(data);
  sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}
