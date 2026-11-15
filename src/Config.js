/**
 * 固定の設定。
 * 店長が変える値（時間差・フォルダID・コース対応表など）は「設定」シートに置き、
 * ここにはシート名・列名・CSV/フォームの見出しなど「作る人」が決める値だけを置く。
 */

var SHEET = {
  COUNSELING: 'フォーム回答_カウンセリング',
  RESERVATION: 'フォーム回答_予約',
  VISITS: '来店記録',
  SALES: '売上取込',
  CUSTOMERS: '顧客台帳',
  SETTINGS: '設定',
  LOG: 'ログ',
};

// 各シートの見出し。列の位置ではなく見出し名で読み書きするので、列の並べ替えには強い。
var HEADERS = {
  VISITS: ['来店ID', '来店日時', '顧客ID', 'コース', 'スマレジ取引ID', '金額', '突合ステータス', '備考'],
  SALES: ['取引ID', '取引日時', '取引区分', '商品名', '金額', '紐づけ来店ID', '突合ステータス'],
  CUSTOMERS: ['顧客ID', '氏名', '初回来店日', '最終来店日', '来店回数', '累計売上', '前回コース'],
  RESERVATION_JUDGE: ['判定', '来店回数', '前回コース', '前回来店日'],
  LOG: ['日時', '処理', 'レベル', 'メッセージ'],
};

// 先頭の0が消えないよう、書式を「書式なしテキスト」にする列
var TEXT_COLUMNS = {
  VISITS: ['来店ID', '顧客ID', 'スマレジ取引ID'],
  SALES: ['取引ID', '紐づけ来店ID'],
  CUSTOMERS: ['顧客ID'],
};

var STATUS = {
  UNMATCHED: '未突合',
  AUTO_UNIQUE: '自動（一意）',
  AUTO_ORDER: '自動（時間順）',
  NEEDS_REVIEW: '要確認',
  MANUAL: '手動',
  MIGRATED: '移行',
  // 売上取込のみで使う
  NOT_TARGET: '対象外',
  REFUND: '返品・取消',
};

// GASが突合をやり直してよいステータス（来店記録）
var REMATCHABLE_STATUSES = [STATUS.UNMATCHED, STATUS.NEEDS_REVIEW, ''];

// フォームの質問文（＝回答シートの見出し）。フォームの文言を変えたらここも合わせる。
// 【未確定】実際のフォームを受け取ったら合わせる。
var FORM_FIELDS = {
  COUNSELING: {
    timestamp: ['タイムスタンプ'],
    name: ['お名前', '氏名', '名前'],
    phone: ['電話番号'],
    course: ['コース', 'ご希望のコース'],
  },
  RESERVATION: {
    timestamp: ['タイムスタンプ'],
    name: ['お名前', '氏名', '名前'],
    phone: ['電話番号'],
  },
  // migrateLegacy 用。旧運用で手入力していた金額の列。
  LEGACY_AMOUNT: ['金額', '売上', '料金'],
};

// スマレジ取引履歴CSVの見出し。候補の中で最初に見つかった列を使う。
// 【未確定】実際のCSVを受け取ったら合わせる。
var CSV_COLUMNS = {
  id: ['取引ID'],
  datetime: ['取引日時'],
  type: ['取引区分'],
  product: ['商品名'],
  amount: ['小計', '金額', '値引き後小計', '商品小計'],
};

// 「設定」シートの項目名と初期値
var SETTING_KEYS = {
  MAX_HOURS: '許容する時間差（時間）',
  IMPORT_FOLDER_ID: '01_取込フォルダID',
  DONE_FOLDER_ID: '02_処理済フォルダID',
  SEARCH_SPREADSHEET_ID: '検索用スプレッドシートID',
  SEARCH_COLUMNS: '検索用に出す列',
  NOTIFY_EMAIL: '通知先メール',
  REFUND_TYPES: '返品・取消の取引区分',
  AMOUNT_MODE: '金額の集計方法',
  MIGRATE_MATCH_FROM: '移行時に突合する開始日',
};

var SETTING_DEFAULTS = [
  [SETTING_KEYS.MAX_HOURS, 5, '来店（フォーム送信）から会計までの最大時間'],
  [SETTING_KEYS.IMPORT_FOLDER_ID, '', 'GoogleドライブのフォルダURLの末尾'],
  [SETTING_KEYS.DONE_FOLDER_ID, '', '同上'],
  [SETTING_KEYS.SEARCH_SPREADSHEET_ID, '', 'バイト用の検索ファイルのURLの /d/ と /edit の間'],
  [SETTING_KEYS.SEARCH_COLUMNS, '顧客ID,氏名,最終来店日,来店回数,前回コース', '顧客台帳のうち検索用ファイルに出す列（カンマ区切り）'],
  [SETTING_KEYS.NOTIFY_EMAIL, '', '要確認やエラーの通知先（カンマ区切りで複数可）'],
  [SETTING_KEYS.REFUND_TYPES, '返品,取消', 'CSVの取引区分のうち、返品・取消として扱う値'],
  [SETTING_KEYS.AMOUNT_MODE, '合計', '合計＝明細の金額を足す／先頭＝明細の先頭行の金額を使う（取引合計が各行に入っている場合）'],
  [SETTING_KEYS.MIGRATE_MATCH_FROM, '', '移行時、この日以降の来店は突合の対象にする（精度確認用。空なら全件「移行」）'],
];

// 設定シート内のコース対応表の位置（D列〜E列）
var COURSE_MAP_HEADER = ['スマレジ商品名', 'フォームのコース名'];
var COURSE_MAP_COLUMN = 4;

var LOG_MAX_ROWS = 2000;
