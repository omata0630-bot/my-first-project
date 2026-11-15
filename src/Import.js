/**
 * スマレジ取引履歴CSVの取込と、来店記録との突合。
 */

// 商品名の列に複数の商品をまとめて書くときの区切り
var PRODUCT_SEPARATOR = ' | ';
// GASが書いた備考の目印。これで始まる備考だけをGASは消してよい。
var AUTO_NOTE_PREFIX = '[自動] ';
// 先に試す順。Windows-31J は Shift_JIS に丸数字・～などを足したもの（スマレジのCSVはこちらの可能性が高い）
var CSV_ENCODINGS = ['Windows-31J', 'Shift_JIS', 'UTF-8'];

/**
 * CSVファイルを読んで、取引IDごとにまとめた取引の配列を返す。
 * 文字コードは Shift_JIS 系で読み、見出しが読めなければ UTF-8 で読み直す。
 */
function readSmaregiCsv(file, amountMode) {
  var blob = file.getBlob();
  var decoded = [];
  CSV_ENCODINGS.forEach(function (enc) {
    try {
      decoded.push({ encoding: enc, text: blob.getDataAsString(enc) });
    } catch (e) {
      // この環境で使えない文字コードは飛ばす
    }
  });
  var required = Object.keys(CSV_COLUMNS).map(function (k) { return CSV_COLUMNS[k]; });
  var picked = pickDecodedCsv(decoded, required);
  if (!picked) throw new Error(file.getName() + ': 文字コードを判定できません');

  var values = Utilities.parseCsv(picked.text.replace(/^﻿/, ''));
  var parsed = csvRowsToLines(values, CSV_COLUMNS);
  if (parsed.missing.length > 0) {
    throw new Error(file.getName() + ': 必要な列が見つかりません（' + parsed.missing.join('、') +
      '）。CSVの見出し: ' + parsed.headers.join(','));
  }
  var txs = groupTransactions(parsed.lines, amountMode);
  var broken = txs.filter(function (tx) { return !tx.datetime; });
  if (broken.length > 0) {
    throw new Error(file.getName() + ': 取引日時を読めない取引があります（取引ID: ' +
      broken.slice(0, 5).map(function (tx) { return tx.id; }).join(',') + '）');
  }
  writeLog('readSmaregiCsv', 'INFO', file.getName() + ' を ' + picked.encoding + ' で読込（' + txs.length + '取引）');
  return txs;
}

/**
 * 取引を売上取込シートに追加する。取引IDが同じものは追加しない。
 * 既にある取引の取引区分が変わっていたら（例：後から取消）区分だけ更新する。
 * @return {{added: number, updated: number, changedIds: string[]}} changedIds は追加・更新した取引ID
 */
function saveTransactions(txs) {
  var t = readTable(getSheetOrThrow(SHEET.SALES));
  var cId = t.col('取引ID');
  var cType = t.col('取引区分');
  var rowById = {};
  t.rows.forEach(function (r) { rowById[String(r[cId])] = r; });

  var added = [];
  var updated = 0;
  var changedIds = [];
  txs.forEach(function (tx) {
    var existing = rowById[tx.id];
    if (existing) {
      if (String(existing[cType]) !== tx.type) {
        existing[cType] = tx.type;
        updated++;
        changedIds.push(tx.id);
      }
      return;
    }
    var row = objectToRow(t, {
      '取引ID': tx.id,
      '取引日時': tx.datetime,
      '取引区分': tx.type,
      '商品名': tx.products.join(PRODUCT_SEPARATOR),
      '金額': tx.amount,
    });
    rowById[tx.id] = row;
    added.push(row);
    changedIds.push(tx.id);
  });
  if (updated > 0) writeTableRows(t, t.rows, TEXT_COLUMNS.SALES);
  appendTableRows(t, added, TEXT_COLUMNS.SALES);
  return { added: added.length, updated: updated, changedIds: changedIds };
}

/**
 * 来店記録と売上取込を突合し、両方のシートの紐づけ・ステータスを書き直す。
 * 来店記録の「スマレジ取引ID」を正とし、売上取込の「紐づけ来店ID」はそこから作る。
 * 「手動」「移行」の来店は上書きしない。
 * @return {{autoUnique: number, autoOrder: number, reviewVisits: Array<Object>, reviewTxs: Array<Object>, refundTxs: Array<Object>}}
 */
function reconcile() {
  var settings = getSettings();
  var maxHours = Number(settings.get(SETTING_KEYS.MAX_HOURS)) || 5;
  var refundTypes = splitList(settings.get(SETTING_KEYS.REFUND_TYPES));

  var vt = readTable(getSheetOrThrow(SHEET.VISITS));
  var st = readTable(getSheetOrThrow(SHEET.SALES));
  var v = {
    id: vt.col('来店ID'), date: vt.col('来店日時'), course: vt.col('コース'), tx: vt.col('スマレジ取引ID'),
    amount: vt.col('金額'), status: vt.col('突合ステータス'), note: vt.col('備考'),
  };
  var s = {
    id: st.col('取引ID'), date: st.col('取引日時'), type: st.col('取引区分'), product: st.col('商品名'),
    amount: st.col('金額'), visit: st.col('紐づけ来店ID'), status: st.col('突合ステータス'),
  };

  var txById = {};
  var latestTxDay = '';
  st.rows.forEach(function (r) {
    var id = String(r[s.id]).trim();
    if (!id) return;
    txById[id] = r;
    var d = parseDateTime(r[s.date]);
    if (d && dayKey(d) > latestTxDay) latestTxDay = dayKey(d);
  });
  var isRefund = function (txRow) { return refundTypes.indexOf(String(txRow[s.type]).trim()) !== -1; };
  var isLocked = function (r) { return r[v.status] === STATUS.MANUAL || r[v.status] === STATUS.MIGRATED; };
  var setReview = function (r, note) {
    r[v.tx] = '';
    r[v.amount] = '';
    r[v.status] = STATUS.NEEDS_REVIEW;
    r[v.note] = AUTO_NOTE_PREFIX + note;
  };

  // 1. 既存の紐づけを確認する（手動を優先。返品・取消になった自動の紐づけは外す）
  var linkMap = {};
  vt.rows.forEach(function (r) {
    var txId = String(r[v.tx]).trim();
    if (txId && r[v.status] === STATUS.MANUAL) linkMap[txId] = r;
  });
  vt.rows.forEach(function (r) {
    var txId = String(r[v.tx]).trim();
    if (!txId || r[v.status] === STATUS.MANUAL) return;
    if (linkMap[txId]) return setReview(r, '取引 ' + txId + ' は手動で別の来店に紐づけられました');
    if (txById[txId] && isRefund(txById[txId]) && !isLocked(r)) {
      return setReview(r, '取引 ' + txId + ' がスマレジで返品・取消されています');
    }
    linkMap[txId] = r;
  });
  // 手動で取引IDだけ入れた行は、金額を売上から補う
  vt.rows.forEach(function (r) {
    var txId = String(r[v.tx]).trim();
    if (txId && r[v.status] === STATUS.MANUAL && r[v.amount] === '' && txById[txId]) {
      r[v.amount] = txById[txId][s.amount];
    }
  });

  // 2. まだ紐づいていない来店と取引を突合する
  var openVisits = [];
  var visitById = {};
  vt.rows.forEach(function (r) {
    if (String(r[v.tx]).trim() || REMATCHABLE_STATUSES.indexOf(r[v.status]) === -1) return;
    var d = parseDateTime(r[v.date]);
    if (!d) return;
    var id = String(r[v.id]);
    visitById[id] = r;
    openVisits.push({ id: id, datetime: d, course: String(r[v.course]).trim() });
  });
  var openTxs = [];
  Object.keys(txById).forEach(function (id) {
    var r = txById[id];
    if (linkMap[id] || isRefund(r)) return;
    openTxs.push({
      id: id,
      datetime: parseDateTime(r[s.date]),
      products: String(r[s.product]).split(PRODUCT_SEPARATOR).map(function (p) { return p.trim(); }),
    });
  });
  var result = matchVisits(openVisits, openTxs, settings.courseMap, maxHours);

  var summary = { autoUnique: 0, autoOrder: 0, reviewVisits: [], reviewTxs: [], refundTxs: [] };
  result.assignments.forEach(function (a) {
    var r = visitById[a.visitId];
    r[v.tx] = a.txId;
    r[v.amount] = txById[a.txId][s.amount];
    r[v.status] = a.status;
    if (String(r[v.note]).indexOf(AUTO_NOTE_PREFIX) === 0) r[v.note] = '';
    linkMap[a.txId] = r;
    if (a.status === STATUS.AUTO_UNIQUE) summary.autoUnique++; else summary.autoOrder++;
  });
  // その日の売上を取り込み済みなのに会計が見つからない来店は要確認
  openVisits.forEach(function (ov) {
    var r = visitById[ov.id];
    if (String(r[v.tx]).trim()) return;
    if (dayKey(ov.datetime) <= latestTxDay) {
      setReview(r, '該当する会計が見つかりません');
    } else {
      r[v.status] = STATUS.UNMATCHED;
    }
  });

  // 3. 売上取込の紐づけ来店ID・ステータスを来店記録から作り直す
  var notTarget = {};
  result.notTargetTxIds.forEach(function (id) { notTarget[id] = true; });
  st.rows.forEach(function (r) {
    var id = String(r[s.id]).trim();
    if (!id) return;
    var visitRow = linkMap[id];
    r[s.visit] = visitRow ? visitRow[v.id] : '';
    if (visitRow) {
      r[s.status] = visitRow[v.status];
    } else if (isRefund(r)) {
      r[s.status] = STATUS.REFUND;
    } else if (notTarget[id]) {
      r[s.status] = STATUS.NOT_TARGET;
    } else {
      r[s.status] = STATUS.NEEDS_REVIEW;
    }
  });

  writeTableRows(vt, vt.rows, TEXT_COLUMNS.VISITS);
  writeTableRows(st, st.rows, TEXT_COLUMNS.SALES);

  vt.rows.forEach(function (r) {
    if (r[v.status] === STATUS.NEEDS_REVIEW) summary.reviewVisits.push(rowToObject(vt, r));
  });
  st.rows.forEach(function (r) {
    if (r[s.status] === STATUS.NEEDS_REVIEW) summary.reviewTxs.push(rowToObject(st, r));
    if (r[s.status] === STATUS.REFUND) summary.refundTxs.push(rowToObject(st, r));
  });
  return summary;
}
