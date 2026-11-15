/**
 * 過去データの移行と、突合の精度確認。
 */

var LEGACY_AMOUNT_NOTE = '手入力金額: ';

/**
 * 既存のカウンセリング回答（コース・金額を手入力していたもの）から来店記録と顧客台帳を作る。
 * 初回に手動で1回実行する。同じ来店日時・顧客IDの行は飛ばすので、もう一度実行しても重複しない。
 *
 * 設定「移行時に突合する開始日」より前の来店は「移行」（手入力の金額をそのまま使い、突合しない）。
 * 開始日以降の来店は「未突合」にして、スマレジCSVと突合する。手入力の金額は備考に残し、
 * reportMatchAccuracy で突合の結果と比べられるようにする。
 */
function migrateLegacy() {
  withLock(function () {
    var matchFrom = parseDateTime(getSettings().get(SETTING_KEYS.MIGRATE_MATCH_FROM));
    var sheet = getSheetOrThrow(SHEET.COUNSELING);
    var values = sheet.getDataRange().getValues();
    var headers = values[0];
    var f = FORM_FIELDS.COUNSELING;

    var visits = readTable(getSheetOrThrow(SHEET.VISITS));
    var existing = {};
    visits.rows.forEach(function (r) {
      var d = parseDateTime(r[visits.col('来店日時')]);
      if (d) existing[d.getTime() + '_' + normalizePhone(r[visits.col('顧客ID')])] = true;
    });

    var names = {};
    var newRows = [];
    var skipped = [];
    values.slice(1).forEach(function (row, i) {
      var rowNumber = i + 2;
      var customerId = normalizePhone(pickField(headers, row, f.phone));
      var datetime = parseDateTime(pickField(headers, row, f.timestamp));
      if (!customerId || !datetime) {
        if (row.join('') !== '') skipped.push(rowNumber);
        return;
      }
      var name = String(pickField(headers, row, f.name)).trim();
      if (name) names[customerId] = name; // 新しい行ほど後なので、最新の氏名が残る

      var key = datetime.getTime() + '_' + customerId;
      if (existing[key]) return;
      existing[key] = true;

      var amount = pickField(headers, row, FORM_FIELDS.LEGACY_AMOUNT);
      var toMatch = matchFrom && datetime >= matchFrom;
      newRows.push(objectToRow(visits, {
        '来店ID': newVisitId_(datetime),
        '来店日時': datetime,
        '顧客ID': customerId,
        'コース': String(pickField(headers, row, f.course)).trim(),
        '金額': toMatch ? '' : parseAmount(amount),
        '突合ステータス': toMatch ? STATUS.UNMATCHED : STATUS.MIGRATED,
        '備考': toMatch && amount !== '' ? LEGACY_AMOUNT_NOTE + parseAmount(amount) : '',
      }));
    });

    newRows.sort(function (a, b) { return a[visits.col('来店日時')] - b[visits.col('来店日時')]; });
    appendTableRows(visits, newRows, TEXT_COLUMNS.VISITS);
    rebuildCustomers(names);
    writeLog('migrateLegacy', 'INFO', newRows.length + '件を移行' +
      (skipped.length > 0 ? '。電話番号か日時がない行を飛ばしました: ' + skipped.join(',') + '行目' : ''));
  });
}

/**
 * 移行時に「未突合」にした来店について、突合の結果を手入力の金額と比べてログに出す。
 * 過去1か月分のCSVを取り込んだ後に実行する。
 */
function reportMatchAccuracy() {
  var t = readTable(getSheetOrThrow(SHEET.VISITS));
  var counts = {};
  var amountOk = 0;
  var amountNg = [];
  t.rows.forEach(function (r) {
    var note = String(r[t.col('備考')]);
    if (note.indexOf(LEGACY_AMOUNT_NOTE) !== 0) return;
    var status = r[t.col('突合ステータス')];
    counts[status] = (counts[status] || 0) + 1;
    if (r[t.col('スマレジ取引ID')] === '') return;
    var legacy = parseAmount(note.slice(LEGACY_AMOUNT_NOTE.length));
    if (parseAmount(r[t.col('金額')]) === legacy) amountOk++;
    else amountNg.push(r[t.col('来店ID')]);
  });
  var total = Object.keys(counts).reduce(function (sum, k) { return sum + counts[k]; }, 0);
  var message = '対象 ' + total + '件／' +
    Object.keys(counts).map(function (k) { return k + ' ' + counts[k] + '件'; }).join('、') +
    '／紐づいた来店の金額 一致 ' + amountOk + '件・不一致 ' + amountNg.length + '件' +
    (amountNg.length > 0 ? '（' + amountNg.slice(0, 20).join(', ') + '）' : '');
  writeLog('reportMatchAccuracy', 'INFO', message);
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    // エディタから実行したときはUIがない
  }
  return message;
}
