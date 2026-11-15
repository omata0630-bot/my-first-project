// シートを使う処理（取込・突合・台帳）を、メモリ上の偽スプレッドシートで通しで確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
    if (row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
      throw new Error('範囲がシートの外です');
    }
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  clearContent() { return this.setValues(this.getValues().map((l) => l.map(() => ''))); }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
}

class FakeSheet {
  constructor(name, data = []) {
    this.name = name;
    this.data = data.map((r) => r.slice());
    this.maxRows = Math.max(1000, this.data.length);
    this.maxCols = 26;
  }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  nonEmpty(r) { return r && r.some((v) => v !== '' && v !== undefined); }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length; i > 0; i--) if (this.nonEmpty(this.data[i - 1])) return i;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((r) => r.forEach((v, i) => { if (v !== '' && v !== undefined) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(values) { this.data.push(values.slice()); }
  deleteRows(start, n) { this.data.splice(start - 1, n); }
  setFrozenRows() {}
  clearContents() { this.data = []; }
}

function createEnv() {
  const sheets = {};
  const book = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new FakeSheet(n)),
    getUrl: () => 'https://example.invalid',
  };
  const ctx = vm.createContext({
    console: { log() {}, error() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => book, getUi: () => { throw new Error('no ui'); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      getUuid: () => Math.random().toString(16).slice(2, 10),
      formatDate: (d) => d.toISOString(),
    },
  });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js'))) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
  }
  // 設定シートと各シートを用意する
  sheets['設定'] = new FakeSheet('設定', [
    ['項目', '値', '説明', 'スマレジ商品名', 'フォームのコース名'],
    ['許容する時間差（時間）', 5, '', 'カット', 'カット'],
    ['返品・取消の取引区分', '返品,取消', '', 'カラー', 'カラー'],
    ['金額の集計方法', '合計', '', '', ''],
  ]);
  for (const [name, headers] of [['来店記録', ctx.HEADERS.VISITS], ['売上取込', ctx.HEADERS.SALES],
    ['顧客台帳', ctx.HEADERS.CUSTOMERS], ['ログ', ctx.HEADERS.LOG]]) {
    sheets[name] = new FakeSheet(name, [headers.slice()]);
  }
  sheets['フォーム回答_カウンセリング'] = new FakeSheet('フォーム回答_カウンセリング', [
    ['タイムスタンプ', 'お名前', '電話番号', 'コース', '体調'],
  ]);
  return { ctx, sheets };
}

const at = (h, m = 0, d = 15) => new Date(2026, 10, d, h, m);
const rowsOf = (sheet) => {
  const [headers, ...rows] = sheet.data;
  return rows.filter((r) => sheet.nonEmpty(r)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
};

function submitCounseling(env, ts, name, phone, course) {
  const s = env.sheets['フォーム回答_カウンセリング'];
  s.appendRow([ts, name, phone, course, '良好']);
  return env.ctx.addVisitFromCounselingRow(s.getLastRow());
}

test('カウンセリング → 取込 → 突合 → 台帳 を通しで行う', () => {
  const env = createEnv();
  const { ctx, sheets } = env;

  assert.equal(submitCounseling(env, at(10), '山田花子', '090-1111-2222', 'カット'), true);
  assert.equal(submitCounseling(env, at(10, 30), '佐藤', 9033334444, 'カット'), true);
  assert.equal(submitCounseling(env, at(11), '鈴木', '080-5555-6666', 'カラー'), true);
  // 同じ行をもう一度処理しても二重登録しない
  assert.equal(ctx.addVisitFromCounselingRow(2), false);
  assert.equal(rowsOf(sheets['来店記録']).length, 3);

  const txs = ctx.groupTransactions([
    { id: 'T1', datetime: '2026-11-15 11:00', type: '通常', product: 'カット', amount: '5000' },
    { id: 'T1', datetime: '2026-11-15 11:00', type: '通常', product: 'シャンプー', amount: '2000' },
    { id: 'T2', datetime: '2026-11-15 11:30', type: '通常', product: 'カット', amount: '5000' },
    { id: 'T3', datetime: '2026-11-15 12:00', type: '通常', product: 'シャンプー', amount: '2000' },
  ], '合計');
  assert.equal(ctx.saveTransactions(txs).added, 3);
  assert.equal(ctx.saveTransactions(txs).added, 0); // 取引IDで重複を除く

  const summary = ctx.reconcile();
  ctx.rebuildCustomers();
  assert.equal(summary.autoOrder, 2);
  assert.equal(summary.reviewVisits.length, 1); // カラーの会計がない
  assert.equal(summary.reviewTxs.length, 0);

  const visits = rowsOf(sheets['来店記録']);
  assert.equal(visits[0]['スマレジ取引ID'], 'T1');
  assert.equal(visits[0]['金額'], 7000);
  assert.equal(visits[1]['顧客ID'], '09033334444');
  assert.equal(visits[1]['スマレジ取引ID'], 'T2');
  assert.equal(visits[2]['突合ステータス'], '要確認');

  const sales = rowsOf(sheets['売上取込']);
  assert.deepEqual(sales.map((r) => r['突合ステータス']), ['自動（時間順）', '自動（時間順）', '対象外']);
  assert.equal(sales[0]['紐づけ来店ID'], visits[0]['来店ID']);

  const customers = rowsOf(sheets['顧客台帳']);
  const yamada = customers.find((c) => c['顧客ID'] === '09011112222');
  assert.equal(yamada['氏名'], '山田花子');
  assert.equal(yamada['累計売上'], 7000);
  assert.equal(yamada['来店回数'], 1);

  // 店長が手で直した行は、以後上書きされない
  const vSheet = sheets['来店記録'];
  const h = vSheet.data[0];
  vSheet.data[3][h.indexOf('スマレジ取引ID')] = 'T3';
  vSheet.data[3][h.indexOf('突合ステータス')] = '手動';
  ctx.reconcile();
  const fixed = rowsOf(vSheet)[2];
  assert.equal(fixed['突合ステータス'], '手動');
  assert.equal(fixed['金額'], 2000); // 金額は売上から補う
  assert.equal(rowsOf(sheets['売上取込'])[2]['紐づけ来店ID'], fixed['来店ID']);

  // 後から取消になった取引は、自動の紐づけを外して要確認にする
  ctx.saveTransactions([{ id: 'T2', datetime: at(11, 30), type: '取消', products: ['カット'], amount: 5000 }]);
  const s2 = ctx.reconcile();
  assert.equal(rowsOf(vSheet)[1]['突合ステータス'], '要確認');
  assert.equal(rowsOf(vSheet)[1]['スマレジ取引ID'], '');
  assert.equal(s2.refundTxs.length, 1);
});

test('売上を取り込んでいない日の来店は未突合のまま', () => {
  const env = createEnv();
  submitCounseling(env, at(10, 0, 16), 'A', '09000000000', 'カット');
  env.ctx.saveTransactions(env.ctx.groupTransactions([
    { id: 'T1', datetime: '2026-11-15 11:00', type: '通常', product: 'カラー', amount: '8000' },
  ], '合計'));
  const summary = env.ctx.reconcile();
  assert.equal(rowsOf(env.sheets['来店記録'])[0]['突合ステータス'], '未突合');
  assert.equal(summary.reviewTxs.length, 1);
});

test('migrateLegacy: 開始日より前は移行、以降は未突合にして手入力金額を備考に残す', () => {
  const env = createEnv();
  const s = env.sheets['フォーム回答_カウンセリング'];
  s.data[0].push('金額');
  s.appendRow([at(10, 0, 1), 'A', '09011112222', 'カット', '', '5000']);
  s.appendRow([at(10, 0, 15), 'A2', '09011112222', 'カラー', '', '8,000']);
  s.appendRow([at(10, 0, 15), '', '', '', '', '']);
  env.sheets['設定'].appendRow(['移行時に突合する開始日', new Date(2026, 10, 10)]);

  env.ctx.migrateLegacy();
  env.ctx.migrateLegacy(); // 2回目は何も増えない
  const visits = rowsOf(env.sheets['来店記録']);
  assert.equal(visits.length, 2);
  assert.equal(visits[0]['突合ステータス'], '移行');
  assert.equal(visits[0]['金額'], 5000);
  assert.equal(visits[1]['突合ステータス'], '未突合');
  assert.equal(visits[1]['備考'], '手入力金額: 8000');
  const c = rowsOf(env.sheets['顧客台帳'])[0];
  assert.equal(c['氏名'], 'A2');
  assert.equal(c['来店回数'], 2);
});
