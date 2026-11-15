/**
 * フォーム送信時の処理。
 * カウンセリングと予約の2つのフォームを同じスプレッドシートにつなぐと、
 * 「フォーム送信時」トリガーはどちらの送信でも同じ関数を呼ぶので、回答シート名で振り分ける。
 */

function onFormSubmitRouter(e) {
  var sheetName = e.range.getSheet().getName();
  if (sheetName === SHEET.COUNSELING) return onCounselingSubmit(e);
  if (sheetName === SHEET.RESERVATION) return onReservationSubmit(e);
  writeLog('onFormSubmitRouter', 'WARN', '対象外のシートからの送信: ' + sheetName);
}

/** カウンセリングフォームの送信 → 来店記録に追加し、顧客台帳を更新する */
function onCounselingSubmit(e) {
  try {
    withLock(function () {
      addVisitFromCounselingRow(e.range.getRow());
    });
  } catch (err) {
    writeLog('onCounselingSubmit', 'ERROR', err.stack || err);
    notifyError_('カウンセリングの取り込みでエラー', err);
  }
}

/**
 * カウンセリング回答シートの指定行から来店記録を作る。
 * トリガーが失敗したときは、この関数に行番号を渡して手で再実行できる。
 * @return {boolean} 追加したら true（同じ来店が既にあれば false）
 */
function addVisitFromCounselingRow(rowNumber) {
  var sheet = getSheetOrThrow(SHEET.COUNSELING);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var f = FORM_FIELDS.COUNSELING;

  var customerId = normalizePhone(pickField(headers, row, f.phone));
  var datetime = parseDateTime(pickField(headers, row, f.timestamp)) || new Date();
  var name = String(pickField(headers, row, f.name)).trim();
  var course = String(pickField(headers, row, f.course)).trim();
  if (!customerId) throw new Error(rowNumber + '行目: 電話番号が空です');

  var visits = readTable(getSheetOrThrow(SHEET.VISITS));
  if (findVisitRow_(visits, datetime, customerId) !== -1) {
    writeLog('onCounselingSubmit', 'INFO', rowNumber + '行目は登録済みのためスキップ');
    return false;
  }
  appendTableRows(visits, [objectToRow(visits, {
    '来店ID': newVisitId_(datetime),
    '来店日時': datetime,
    '顧客ID': customerId,
    'コース': course,
    '突合ステータス': STATUS.UNMATCHED,
  })], TEXT_COLUMNS.VISITS);

  var names = {};
  if (name) names[customerId] = name;
  rebuildCustomers(names);
  writeLog('onCounselingSubmit', 'INFO', rowNumber + '行目を来店記録に追加');
  return true;
}

/** 同じ来店日時・顧客IDの来店記録の位置（なければ-1）。二重登録を防ぐ。 */
function findVisitRow_(visits, datetime, customerId) {
  var cDate = visits.col('来店日時');
  var cId = visits.col('顧客ID');
  var time = datetime.getTime();
  for (var i = 0; i < visits.rows.length; i++) {
    var d = parseDateTime(visits.rows[i][cDate]);
    if (d && d.getTime() === time && normalizePhone(visits.rows[i][cId]) === customerId) return i;
  }
  return -1;
}

function newVisitId_(datetime) {
  var stamp = Utilities.formatDate(datetime, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  return 'V' + stamp + '-' + Utilities.getUuid().slice(0, 4);
}

/** 予約フォームの送信 → 電話番号で台帳を検索し、判定列に書き込む */
function onReservationSubmit(e) {
  try {
    withLock(function () {
      judgeReservationRow(e.range.getRow());
    });
  } catch (err) {
    writeLog('onReservationSubmit', 'ERROR', err.stack || err);
    notifyError_('予約の判定でエラー', err);
  }
}

/** 予約回答シートの指定行に判定を書き込む（手で再実行も可） */
function judgeReservationRow(rowNumber) {
  var sheet = getSheetOrThrow(SHEET.RESERVATION);
  var t = ensureHeaders(sheet, HEADERS.RESERVATION_JUDGE);
  var row = t.rows[rowNumber - 2];
  var customerId = normalizePhone(pickField(t.headers, row, FORM_FIELDS.RESERVATION.phone));

  var customer = customerId ? findCustomer_(customerId) : null;
  var values = judgeReservation(customer);
  HEADERS.RESERVATION_JUDGE.forEach(function (h, i) {
    sheet.getRange(rowNumber, t.col(h) + 1).setValue(values[i]);
  });
}

function findCustomer_(customerId) {
  var t = readTable(getSheetOrThrow(SHEET.CUSTOMERS));
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (normalizePhone(r[t.col('顧客ID')]) === customerId) {
      return {
        count: Number(r[t.col('来店回数')]) || 0,
        lastCourse: r[t.col('前回コース')],
        last: r[t.col('最終来店日')],
      };
    }
  }
  return null;
}
