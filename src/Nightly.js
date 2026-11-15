/**
 * 毎日2時の処理:
 * CSV取込 → 突合 → 台帳の再集計 → 検索用ファイルの更新 → 要確認があればメール → CSVを02_処理済へ移動
 * CSVがない日も、店長の手直しを反映するため突合と再集計は行う。
 */

function nightlyImport() {
  var errors = [];
  var processed = [];
  var changedIds = [];
  var summary = null;

  try {
    withLock(function () {
      var settings = getSettings();
      var amountMode = String(settings.get(SETTING_KEYS.AMOUNT_MODE)).trim() || '合計';
      var importFolder = getFolder_(settings, SETTING_KEYS.IMPORT_FOLDER_ID);
      var doneFolder = getFolder_(settings, SETTING_KEYS.DONE_FOLDER_ID);

      listCsvFiles_(importFolder).forEach(function (file) {
        try {
          var result = saveTransactions(readSmaregiCsv(file, amountMode));
          changedIds = changedIds.concat(result.changedIds);
          processed.push(file);
          writeLog('nightlyImport', 'INFO', file.getName() + ': 追加 ' + result.added + '件／区分の更新 ' + result.updated + '件');
        } catch (err) {
          errors.push(String(err.message || err));
          writeLog('nightlyImport', 'ERROR', err.stack || err);
        }
      });

      summary = reconcile();
      rebuildCustomers();
      try {
        updateSearchSheet();
      } catch (err) {
        errors.push('検索用ファイルの更新に失敗: ' + (err.message || err));
        writeLog('nightlyImport', 'ERROR', err.stack || err);
      }

      // 取込に成功したCSVだけ移動する（失敗したものは01_取込に残す）
      processed.forEach(function (file) { file.moveTo(doneFolder); });
      writeLog('nightlyImport', 'INFO', '突合: 自動（一意）' + summary.autoUnique + '件／自動（時間順）' + summary.autoOrder +
        '件／要確認 来店' + summary.reviewVisits.length + '件・取引' + summary.reviewTxs.length + '件');
    });
  } catch (err) {
    errors.push(String(err.message || err));
    writeLog('nightlyImport', 'ERROR', err.stack || err);
  }

  // メールはCSVを取り込んだ日とエラーの日だけ（毎晩同じ要確認を送らない）
  if (errors.length > 0 || processed.length > 0) {
    sendNightlyReport_(processed, summary, changedIds, errors);
  }
}

function getFolder_(settings, key) {
  var id = String(settings.get(key)).trim();
  if (!id) throw new Error('設定「' + key + '」が空です');
  return DriveApp.getFolderById(id);
}

function listCsvFiles_(folder) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (/\.csv$/i.test(f.getName()) || f.getMimeType() === 'text/csv') files.push(f);
  }
  return files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
}

function sendNightlyReport_(processed, summary, changedIds, errors) {
  var to = String(getSettings().get(SETTING_KEYS.NOTIFY_EMAIL)).trim();
  if (!to) return;
  var tz = Session.getScriptTimeZone();
  var fmt = function (d) { return d instanceof Date ? Utilities.formatDate(d, tz, 'M/d HH:mm') : String(d); };
  var lines = [];

  if (errors.length > 0) {
    lines.push('■ エラー（' + errors.length + '件）', errors.join('\n'), '');
  }
  if (processed.length > 0) {
    lines.push('■ 取り込んだCSV', processed.map(function (f) { return '・' + f.getName(); }).join('\n'), '');
  }
  if (summary) {
    lines.push('■ 突合の結果',
      '自動（一意）: ' + summary.autoUnique + '件',
      '自動（時間順）: ' + summary.autoOrder + '件', '');
    if (summary.reviewVisits.length > 0) {
      lines.push('■ 要確認の来店（' + summary.reviewVisits.length + '件）「来店記録」シート');
      summary.reviewVisits.forEach(function (r) {
        lines.push('・' + fmt(r['来店日時']) + ' ' + r['コース'] + '（' + r['来店ID'] + '）' + String(r['備考']).replace(AUTO_NOTE_PREFIX, ''));
      });
      lines.push('');
    }
    if (summary.reviewTxs.length > 0) {
      lines.push('■ 来店に紐づかない会計（' + summary.reviewTxs.length + '件）「売上取込」シート');
      summary.reviewTxs.forEach(function (r) {
        lines.push('・' + fmt(r['取引日時']) + ' ' + r['商品名'] + ' ' + r['金額'] + '円（取引ID ' + r['取引ID'] + '）');
      });
      lines.push('');
    }
    var newRefunds = summary.refundTxs.filter(function (r) { return changedIds.indexOf(String(r['取引ID'])) !== -1; });
    if (newRefunds.length > 0) {
      lines.push('■ 新しい返品・取消（' + newRefunds.length + '件）必要なら来店記録を手で直してください');
      newRefunds.forEach(function (r) {
        lines.push('・' + fmt(r['取引日時']) + ' ' + r['商品名'] + ' ' + r['金額'] + '円（取引ID ' + r['取引ID'] + '）');
      });
      lines.push('');
    }
  }
  lines.push('直し方: 来店記録の「スマレジ取引ID」に正しい取引IDを入れ、「突合ステータス」を「手動」にしてください。',
    '会計がない来店（キャンセル等）は、取引IDを空のまま「手動」にしてください。', '', getBook().getUrl());

  var needsAction = errors.length > 0 || (summary && (summary.reviewVisits.length + summary.reviewTxs.length) > 0);
  MailApp.sendEmail({
    to: to,
    subject: '【サロン管理】' + (needsAction ? '要確認があります' : '取込が完了しました'),
    body: lines.join('\n'),
  });
}

/** フォーム送信などで起きたエラーを通知先に送る */
function notifyError_(title, err) {
  try {
    var to = String(getSettings().get(SETTING_KEYS.NOTIFY_EMAIL)).trim();
    if (!to) return;
    MailApp.sendEmail({
      to: to,
      subject: '【サロン管理】' + title,
      body: String(err.stack || err) + '\n\n「ログ」シートも確認してください。\n' + getBook().getUrl(),
    });
  } catch (e) {
    console.error('エラー通知の送信に失敗: ' + e);
  }
}
