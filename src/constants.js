module.exports = {
  ROOM_ID_LENGTH: 12,
  ROOM_ID_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789',
  NAME_MAX: 9,
  TOPIC_MAX: 20,

  // 入室時の上限（入室後の切り替えでは超えることがある）
  MAX_PARTICIPANTS: 9,
  MAX_SPECTATORS: 10,
  MAX_PARENTS_PER_LAP: 9,
  MIN_PLAYERS: { normal: 2, minna: 3 },

  // デフォルメ動物のアイコン（重複可）
  ICONS: ['🐶', '🐱', '🐰', '🐻', '🐼', '🦊', '🐸', '🐷', '🐵', '🐯', '🐨', '🐹', '🐧', '🐮', '🐔', '🦁'],

  // ホストが変更できるゲーム設定の範囲
  SETTING_RULES: {
    topicTimeSec: { min: 20, max: 50, step: 5, initial: 30 },
    drawTimeSec: { min: 30, max: 200, step: 10, initial: 100 },
    laps: { min: 1, max: 3, step: 1, initial: 1 },
  },
  MODES: ['normal', 'minna'],

  SELECT_TIME_MS: 15_000,
  SELECT_TIME_MANY_MS: 30_000, // 子が10人以上のとき
  COLLECT_GRACE_MS: 3_000, // 時間切れ後、各端末から絵が届くのを待つ時間
  RATE_LIKE_MS: Number(process.env.RATE_PHASE_MS) || 30_000,
  RATE_UNIQUE_MS: Number(process.env.RATE_PHASE_MS) || 30_000,
  LIKE_LIMIT: 3,
  UNIQUE_LIMIT: 2,
  SEAT_HOLD_MS: Number(process.env.SEAT_HOLD_MS) || 120_000, // 切断・退出後に席を保持する時間
  EMPTY_ROOM_TTL_MS: Number(process.env.EMPTY_ROOM_TTL_MS) || 120_000,

  IMAGE_MAX_LENGTH: 2_000_000,
  IMAGE_PATTERN: /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,

  PARENT_ABSENT_MESSAGE: '親が不在のため今回は1位なしです',

  // 時間内にお題が決まらなかったときに使うお題
  FALLBACK_TOPICS: [
    'キリン', 'ペンギン', 'タコ', 'ピアノ', '自転車', '消防車', 'ひまわり', '雪だるま',
    'ハンバーガー', 'ソフトクリーム', '新幹線', 'カブトムシ', 'コアラ', '観覧車', 'イカ',
    'ロボット', '富士山', 'ゾウ', 'ラーメン', '恐竜',
  ],

  // 親が時間内に1位を選ばなかったときのメッセージ
  TEASE_MESSAGES: [
    '{name}は優柔不断です',
    '{name}は全部1位にしたかったようです',
    '{name}は見とれていて時間を忘れました',
    '{name}はまだ迷っています',
    '{name}には選べませんでした…',
    '{name}は決断力を家に忘れてきました',
    '{name}の心はまだ揺れています',
    '{name}は審査を放棄しました',
    '{name}はうろ覚えすぎて選べませんでした',
    '{name}、あとでみんなに謝りましょう',
  ],
};
