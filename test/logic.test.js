// GASのファイルは import/export がないので、vm でグローバルに読み込んでテストする。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const file of ['Config.js', 'Logic.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), ctx, { filename: file });
}
const g = ctx;
const at = (h, m = 0) => new Date(2026, 10, 15, h, m);
// vm の中の Date は別の realm なので、比較は時刻の数値で行う
const plain = (v) => JSON.parse(JSON.stringify(v));

test('normalizePhone', () => {
  assert.equal(g.normalizePhone('090-1234-5678'), '09012345678');
  assert.equal(g.normalizePhone('０９０－１２３４－５６７８'), '09012345678');
  assert.equal(g.normalizePhone(' 090 1234 5678 '), '09012345678');
  assert.equal(g.normalizePhone('+81 90-1234-5678'), '09012345678');
  assert.equal(g.normalizePhone('+81 090-1234-5678'), '09012345678');
  assert.equal(g.normalizePhone('＋８１９０１２３４５６７８'), '09012345678');
  assert.equal(g.normalizePhone('(03)1234-5678'), '0312345678');
  assert.equal(g.normalizePhone(9012345678), '09012345678'); // シートが数値で読んで0が消えた
  assert.equal(g.normalizePhone(312345678), '0312345678');
  assert.equal(g.normalizePhone(''), '');
  assert.equal(g.normalizePhone(null), '');
});

test('parseAmount', () => {
  assert.equal(g.parseAmount('¥12,000'), 12000);
  assert.equal(g.parseAmount('-1,200'), -1200);
  assert.equal(g.parseAmount('１２００'), 1200);
  assert.equal(g.parseAmount(500), 500);
  assert.equal(g.parseAmount(''), 0);
});

test('parseDateTime', () => {
  assert.equal(g.parseDateTime('2026-11-15 14:32:10').getTime(), new Date(2026, 10, 15, 14, 32, 10).getTime());
  assert.equal(g.parseDateTime('2026/11/5 9:05').getTime(), new Date(2026, 10, 5, 9, 5).getTime());
  assert.equal(g.parseDateTime('2026/11/05').getTime(), new Date(2026, 10, 5).getTime());
  assert.equal(g.parseDateTime('abc'), null);
  assert.equal(g.parseDateTime(''), null);
});

test('pickDecodedCsv: 見出しが読める方を選ぶ', () => {
  const required = [['取引ID'], ['商品名']];
  const picked = g.pickDecodedCsv([
    { encoding: 'Shift_JIS', text: '��,��\n1,2' },
    { encoding: 'UTF-8', text: '﻿取引ID,商品名\n1,カット' },
  ], required);
  assert.equal(picked.encoding, 'UTF-8');
  assert.equal(g.pickDecodedCsv([{ encoding: 'x', text: '�' }], required), null);
});

test('csvRowsToLines: 見出し名で列を拾い、足りない列を返す', () => {
  const values = [
    ['取引ID', '取引日時', '取引区分', '商品名', '小計'],
    ['1001', '2026-11-15 12:00:00', '通常', 'カット', '5000'],
    ['', '', '', '', ''],
  ];
  const r = g.csvRowsToLines(values, g.CSV_COLUMNS);
  assert.deepEqual(plain(r.missing), []);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].amount, '5000');

  const bad = g.csvRowsToLines([['取引ID', '商品名']], g.CSV_COLUMNS);
  assert.ok(bad.missing.length > 0);
});

test('groupTransactions: 取引IDごとにまとめる', () => {
  const lines = [
    { id: '1', datetime: '2026-11-15 12:00', type: '通常', product: 'カット', amount: '5000' },
    { id: '1', datetime: '2026-11-15 12:00', type: '通常', product: 'シャンプー', amount: '2,000' },
    { id: '2', datetime: '2026-11-15 13:00', type: '返品', product: 'シャンプー', amount: '-2000' },
  ];
  const sum = g.groupTransactions(lines, '合計');
  assert.equal(sum.length, 2);
  assert.deepEqual(plain(sum[0].products), ['カット', 'シャンプー']);
  assert.equal(sum[0].amount, 7000);
  assert.equal(sum[1].type, '返品');

  const head = g.groupTransactions([
    { id: '1', datetime: '2026-11-15 12:00', type: '通常', product: 'カット', amount: '7000' },
    { id: '1', datetime: '2026-11-15 12:00', type: '通常', product: 'シャンプー', amount: '7000' },
  ], '先頭');
  assert.equal(head[0].amount, 7000);
});

const courseMap = { 'カット': 'カット', 'カラー': 'カラー', 'カット＋カラー': 'カット＋カラー' };

test('matchVisits: 候補1件は自動（一意）', () => {
  const r = g.matchVisits(
    [{ id: 'V1', datetime: at(10), course: 'カット' }, { id: 'V2', datetime: at(11), course: 'カラー' }],
    [{ id: 'T1', datetime: at(11), products: ['カット'] }, { id: 'T2', datetime: at(13), products: ['カラー', 'シャンプー'] }],
    courseMap, 5);
  assert.deepEqual(plain(r.assignments), [
    { visitId: 'V1', txId: 'T1', status: '自動（一意）' },
    { visitId: 'V2', txId: 'T2', status: '自動（一意）' },
  ]);
  assert.deepEqual(plain(r.unmatchedTxIds), []);
});

test('matchVisits: 同じコースが複数なら時間順', () => {
  const r = g.matchVisits(
    [{ id: 'V2', datetime: at(10, 30), course: 'カット' }, { id: 'V1', datetime: at(10), course: 'カット' }],
    [{ id: 'T2', datetime: at(12), products: ['カット'] }, { id: 'T1', datetime: at(11), products: ['カット'] }],
    courseMap, 5);
  assert.deepEqual(plain(r.assignments), [
    { visitId: 'V1', txId: 'T1', status: '自動（時間順）' },
    { visitId: 'V2', txId: 'T2', status: '自動（時間順）' },
  ]);
});

test('matchVisits: 来店より前・時間差超過・別の日・コース違いは候補にしない', () => {
  const r = g.matchVisits(
    [{ id: 'V1', datetime: at(12), course: 'カット' }],
    [
      { id: 'T_before', datetime: at(11), products: ['カット'] },
      { id: 'T_late', datetime: at(17, 1), products: ['カット'] },
      { id: 'T_other_day', datetime: new Date(2026, 10, 16, 13), products: ['カット'] },
      { id: 'T_other_course', datetime: at(13), products: ['カラー'] },
    ],
    courseMap, 5);
  assert.deepEqual(plain(r.assignments), []);
  assert.deepEqual(plain(r.unmatchedTxIds).sort(), ['T_before', 'T_late', 'T_other_course', 'T_other_day']);
});

test('matchVisits: 対応表にない商品だけの取引は対象外（物販のみ）', () => {
  const r = g.matchVisits([], [{ id: 'T1', datetime: at(12), products: ['シャンプー'] }], courseMap, 5);
  assert.deepEqual(plain(r.notTargetTxIds), ['T1']);
  assert.deepEqual(plain(r.unmatchedTxIds), []);
});

test('matchVisits: 来店が早い順に割り当てて取りこぼさない', () => {
  // T1(14:00) は V1(9:00) と V2(13:00) の両方が候補。T2(14:30) は V2 だけが候補（V1から5時間超）。
  // T1 に早い方の V1 を当てれば、T2 も V2 に紐づく。
  const r = g.matchVisits(
    [{ id: 'V1', datetime: at(9), course: 'カット' }, { id: 'V2', datetime: at(13), course: 'カット' }],
    [{ id: 'T1', datetime: at(14), products: ['カット'] }, { id: 'T2', datetime: at(14, 30), products: ['カット'] }],
    courseMap, 5);
  assert.deepEqual(plain(r.assignments).map((a) => a.visitId + a.txId), ['V1T1', 'V2T2']);
});

test('aggregateCustomers', () => {
  const agg = g.aggregateCustomers([
    { customerId: '090', datetime: at(10), course: 'カット', amount: 5000 },
    { customerId: '090', datetime: new Date(2026, 9, 1), course: 'カラー', amount: '' },
    { customerId: '080', datetime: at(12), course: 'カラー', amount: 8000 },
    { customerId: '', datetime: at(12), course: 'カラー', amount: 8000 },
  ]);
  assert.deepEqual(Object.keys(agg).sort(), ['080', '090']);
  assert.equal(agg['090'].count, 2);
  assert.equal(agg['090'].total, 5000);
  assert.equal(agg['090'].lastCourse, 'カット');
  assert.equal(agg['090'].first.getTime(), new Date(2026, 9, 1).getTime());
});

test('judgeReservation', () => {
  assert.deepEqual(plain(g.judgeReservation(null)), ['新規', 0, '', '']);
  const last = at(10);
  const r = g.judgeReservation({ count: 3, lastCourse: 'カット', last });
  assert.equal(r[0], 'リピーター');
  assert.equal(r[1], 3);
  assert.equal(r[2], 'カット');
});
