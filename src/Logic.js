/**
 * 判断の中身（純粋な関数）。シートやドライブには触らないので、Nodeでテストできる。
 * テスト: npm test
 */

/**
 * 電話番号を顧客IDの形にそろえる。
 * 全角→半角、ハイフン・空白・括弧を除去、+81→0。
 * シートが数値として読んで先頭の0が消えたもの（9012345678）も0を補う。
 */
function normalizePhone(value) {
  if (value === null || value === undefined) return '';
  var s = String(value)
    .replace(/[０-９＋]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[^0-9+]/g, '');
  if (s.indexOf('+81') === 0) {
    s = '0' + s.slice(3).replace(/^0/, '');
  }
  s = s.replace(/\+/g, '');
  if (/^[1-9]\d{8,9}$/.test(s)) s = '0' + s;
  return s;
}

/** 「¥1,200」「-1200」などを数値にする。読めなければ0。 */
function parseAmount(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return 0;
  var s = String(value)
    .replace(/[０-９－]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[^0-9.\-]/g, '');
  var n = Number(s);
  return isNaN(n) ? 0 : n;
}

/** 「2026-11-15 14:32:10」「2026/11/15 14:32」などを日時にする（スクリプトのタイムゾーンで解釈）。 */
function parseDateTime(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  var m = String(value).trim().match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
}

function dayKey(date) {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/** 見出しの並びから、候補名のうち最初に見つかった列の位置を返す。なければ-1。 */
function findColumn(headers, candidates) {
  var trimmed = headers.map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
  for (var i = 0; i < candidates.length; i++) {
    var idx = trimmed.indexOf(candidates[i]);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * 同じCSVを複数の文字コードで読んだ結果から、正しく読めたものを選ぶ。
 * 1行目に必要な見出しが全部あるものを優先し、なければ文字化け記号のないもの。
 * @param {Array<{encoding: string, text: string}>} decoded
 * @param {Array<Array<string>>} requiredColumns 列ごとの候補名
 */
function pickDecodedCsv(decoded, requiredColumns) {
  for (var i = 0; i < decoded.length; i++) {
    var firstLine = decoded[i].text.replace(/^﻿/, '').split(/\r?\n/)[0] || '';
    var ok = requiredColumns.every(function (cands) {
      return cands.some(function (c) { return firstLine.indexOf(c) !== -1; });
    });
    if (ok) return decoded[i];
  }
  for (var j = 0; j < decoded.length; j++) {
    if (decoded[j].text.indexOf('�') === -1) return decoded[j];
  }
  return null;
}

/**
 * CSVの2次元配列（1行目が見出し）を明細の配列にする。
 * @param {Array<Array<string>>} values
 * @param {Object<string, string[]>} columns CSV_COLUMNS の形
 * @return {{lines: Array<Object>, missing: string[], headers: string[]}} missing は見つからなかった項目
 */
function csvRowsToLines(values, columns) {
  var headers = values[0] || [];
  var idx = {};
  var missing = [];
  Object.keys(columns).forEach(function (key) {
    idx[key] = findColumn(headers, columns[key]);
    if (idx[key] === -1) missing.push(columns[key].join('／'));
  });
  if (missing.length > 0) return { lines: [], missing: missing, headers: headers };
  var lines = values.slice(1)
    .filter(function (r) { return r.join('').trim() !== ''; })
    .map(function (r) {
      var line = {};
      Object.keys(idx).forEach(function (key) { line[key] = r[idx[key]]; });
      return line;
    });
  return { lines: lines, missing: [], headers: headers };
}

/**
 * CSVの明細（商品単位）を取引IDごとにまとめる。
 * @param {Array<{id, datetime, type, product, amount}>} lines
 * @param {string} amountMode '合計'＝明細を足す／'先頭'＝先頭行の金額を使う
 * @return {Array<{id, datetime: Date, type, products: string[], amount: number}>} 出てきた順
 */
function groupTransactions(lines, amountMode) {
  var byId = {};
  var order = [];
  lines.forEach(function (line) {
    var id = String(line.id || '').trim();
    if (!id) return;
    var tx = byId[id];
    if (!tx) {
      tx = byId[id] = {
        id: id,
        datetime: parseDateTime(line.datetime),
        type: String(line.type || '').trim(),
        products: [],
        amount: amountMode === '先頭' ? parseAmount(line.amount) : 0,
      };
      order.push(id);
    }
    var product = String(line.product || '').trim();
    if (product && tx.products.indexOf(product) === -1) tx.products.push(product);
    if (amountMode !== '先頭') tx.amount += parseAmount(line.amount);
  });
  return order.map(function (id) { return byId[id]; });
}

/**
 * 来店記録と売上を突合する。
 * 1. 同じ日・コースが対応表で一致
 * 2. 来店時刻 ≦ 会計時刻 ≦ 来店時刻＋maxHours
 * 3. 候補1件どうし→自動（一意）／同じコースが複数→時間順に割り当てて自動（時間順）
 * 会計が早い順に、まだ割り当てていない候補のうち一番早い来店を割り当てる
 * （来店が早いほど締切も早いので、この順で割り当てると取りこぼしが最も少ない）。
 *
 * @param {Array<{id, datetime: Date, course}>} visits まだ紐づいていない来店
 * @param {Array<{id, datetime: Date, products: string[]}>} transactions まだ紐づいていない通常の取引
 * @param {Object<string, string>} courseMap スマレジ商品名 → フォームのコース名
 * @param {number} maxHours
 * @return {{assignments: Array<{visitId, txId, status}>, unmatchedTxIds: string[], notTargetTxIds: string[]}}
 */
function matchVisits(visits, transactions, courseMap, maxHours) {
  var maxMs = maxHours * 60 * 60 * 1000;
  var result = { assignments: [], unmatchedTxIds: [], notTargetTxIds: [] };

  var txs = transactions.slice().sort(function (a, b) { return a.datetime - b.datetime; });
  var candidatesOfTx = {};
  var candidateCountOfVisit = {};

  txs.forEach(function (tx) {
    var courses = tx.products
      .map(function (p) { return courseMap[p]; })
      .filter(function (c) { return !!c; });
    if (courses.length === 0) {
      candidatesOfTx[tx.id] = null;
      return;
    }
    var cands = visits.filter(function (v) {
      var diff = tx.datetime - v.datetime;
      return courses.indexOf(v.course) !== -1 &&
        dayKey(v.datetime) === dayKey(tx.datetime) &&
        diff >= 0 && diff <= maxMs;
    });
    candidatesOfTx[tx.id] = cands;
    cands.forEach(function (v) {
      candidateCountOfVisit[v.id] = (candidateCountOfVisit[v.id] || 0) + 1;
    });
  });

  var used = {};
  txs.forEach(function (tx) {
    var cands = candidatesOfTx[tx.id];
    if (cands === null) {
      result.notTargetTxIds.push(tx.id);
      return;
    }
    var free = cands
      .filter(function (v) { return !used[v.id]; })
      .sort(function (a, b) { return a.datetime - b.datetime; });
    if (free.length === 0) {
      result.unmatchedTxIds.push(tx.id);
      return;
    }
    var visit = free[0];
    used[visit.id] = true;
    var unique = cands.length === 1 && candidateCountOfVisit[visit.id] === 1;
    result.assignments.push({
      visitId: visit.id,
      txId: tx.id,
      status: unique ? STATUS.AUTO_UNIQUE : STATUS.AUTO_ORDER,
    });
  });
  return result;
}

/**
 * 来店記録から顧客ごとの集計を作る。
 * @param {Array<{customerId, datetime: Date, course, amount}>} visits
 * @return {Object<string, {first: Date, last: Date, count: number, total: number, lastCourse: string}>}
 */
function aggregateCustomers(visits) {
  var map = {};
  visits.forEach(function (v) {
    if (!v.customerId || !v.datetime) return;
    var c = map[v.customerId];
    if (!c) {
      c = map[v.customerId] = { first: v.datetime, last: v.datetime, count: 0, total: 0, lastCourse: v.course || '' };
    }
    c.count += 1;
    c.total += parseAmount(v.amount);
    if (v.datetime < c.first) c.first = v.datetime;
    if (v.datetime >= c.last) {
      c.last = v.datetime;
      c.lastCourse = v.course || '';
    }
  });
  return map;
}

/** 予約フォームの判定列に書く値 [判定, 来店回数, 前回コース, 前回来店日] */
function judgeReservation(customer) {
  if (!customer || !customer.count) return ['新規', 0, '', ''];
  return ['リピーター', customer.count, customer.lastCourse || '', customer.last || ''];
}

/** 「返品,取消」のようなカンマ区切りを配列にする */
function splitList(value) {
  return String(value || '')
    .split(/[,、，]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}
