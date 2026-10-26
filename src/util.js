const crypto = require('crypto');
const { IMAGE_MAX_LENGTH, IMAGE_PATTERN, TOPIC_MAX } = require('./constants');

const randomItem = (list) => list[crypto.randomInt(list.length)];

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const randomId = () => crypto.randomBytes(8).toString('hex');

function isValidImage(image) {
  return typeof image === 'string' && image.length <= IMAGE_MAX_LENGTH && IMAGE_PATTERN.test(image);
}

// お題の入力チェック。正しければ { topic }、だめなら { error }
function parseTopic(raw) {
  const topic = typeof raw === 'string' ? raw.trim() : '';
  if (!topic) return { error: 'お題を入力してください' };
  if ([...topic].length > TOPIC_MAX) return { error: `お題は${TOPIC_MAX}文字までです` };
  return { topic };
}

// 同数は同率順位（1, 1, 3, …）
function rankBy(items, score) {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  return sorted.map((item) => ({
    item,
    score: score(item),
    rank: 1 + sorted.filter((other) => score(other) > score(item)).length,
  }));
}

const fail = (error) => ({ ok: false, error });
const OK = Object.freeze({ ok: true });

module.exports = { randomItem, shuffle, randomId, isValidImage, parseTopic, rankBy, fail, OK };
