/**
 * Уровень 2 — Boundary & Corner Cases.
 * Граничные значения, null-проверки, мусор на входе, офлайн.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { normalizeTmdbMovie, buildTags, deriveMoodVector, computeQuality, parseTitleId, makeTitleId, clamp } from '../shared/model/title.js';
import { normalizeRoomCode, roomPath, generateRoomCode, isValidRoomCode } from '../shared/model/roomCode.js';
import { slugifyTag } from '../shared/taxonomy/tagOntology.js';
import { RECOMMENDATION_CONFIG, mergeConfig, NEUTRAL_MOOD } from '../shared/config/recommendation.js';
import {
  createEmptyProfile, hydrateProfile, applySignal, decayProfile,
  pruneProfile, topTags, serializeProfile, profileBreadth, isWarm, ACTION,
} from '../src/engine/tasteProfile.js';
import { rankDeck, scoreTitle, buildConsensusProfile, matchedTags } from '../src/engine/ranking.js';
import { cacheKeyFor } from '../api/_lib/cache.js';
import { validateInitData, botToken as readBotToken, botIdFromToken } from '../api/_lib/telegram.js';
import { usernameFromTelegram } from '../api/_lib/identity.js';
import { describeError, ApiClientError } from '../src/lib/api.js';
import { LIBRARY, ALL_TITLES, makeTitle, seededRandom } from './helpers/fixtures.mjs';

test('B1 · невалидные коды комнат отклоняются, а не «почти проходят»', () => {
  for (const bad of [null, undefined, '', '   ', 'ABC', 'ABCDE', 'ЖЖЖЖ', '!!!!', 42, {}, [], '\n\t']) {
    assert.equal(normalizeRoomCode(bad), null, `код ${JSON.stringify(bad)} должен быть отклонён`);
    assert.equal(isValidRoomCode(bad), false);
  }
  assert.throws(() => roomPath('ABC'), /невалидный код/);
});

test('B2 · код очищается от того, что люди дописывают руками', () => {
  // Пробелы и дефисы человек ставит сам, диктуя код вслух.
  assert.equal(normalizeRoomCode('12 345'), '12345');
  assert.equal(normalizeRoomCode('12-345'), '12345');
  assert.equal(normalizeRoomCode(' 12345 '), '12345');
  // Двойная нормализация не меняет результат.
  const once = normalizeRoomCode('54321');
  assert.equal(normalizeRoomCode(once), once);
});

test('B3 · код состоит ровно из пяти цифр', () => {
  const codes = new Set();
  for (let i = 0; i < 3000; i += 1) codes.add(generateRoomCode());
  for (const code of codes) {
    assert.match(code, /^\d{5}$/, `код ${code} не пятизначный`);
  }
  // 3000 генераций из 100k кодов: коллизии возможны, но редки.
  assert.ok(codes.size > 2850, `слишком много коллизий: ${codes.size}/3000`);
});

test('B4 · нормализация переживает мусорный ответ TMDB', () => {
  assert.equal(normalizeTmdbMovie(null), null);
  assert.equal(normalizeTmdbMovie({}), null);
  assert.equal(normalizeTmdbMovie({ id: 0 }), null);

  const minimal = normalizeTmdbMovie({ id: 7 });
  assert.equal(minimal.title, 'Без названия');
  assert.equal(minimal.year, null);
  assert.equal(minimal.poster, null);
  assert.deepEqual(minimal.genreIds, []);
  assert.deepEqual(minimal.cast, []);
  assert.deepEqual(minimal.moods, NEUTRAL_MOOD, 'без данных настроение нейтральное');

  const broken = normalizeTmdbMovie({ id: 8, release_date: 'не дата', vote_average: null, genres: null });
  assert.equal(broken.year, null);
  assert.equal(broken.rating, null);
});

test('B5 · экстремальные значения качества остаются в 0..1', () => {
  for (const input of [
    { voteAverage: 10, voteCount: 1_000_000, popularity: 99999 },
    { voteAverage: 0, voteCount: 0, popularity: 0 },
    { voteAverage: -5, voteCount: -10, popularity: -1 },
    {},
  ]) {
    const { score } = computeQuality(input);
    assert.ok(score >= 0 && score <= 1, `качество вне диапазона для ${JSON.stringify(input)}`);
    assert.ok(Number.isFinite(score));
  }
  assert.equal(computeQuality({ voteAverage: 9, voteCount: 5 }).reliable, false,
    'пять голосов — не статистика');
});

test('B6 · слаг тега устойчив к мусору', () => {
  for (const bad of [null, undefined, '', ' ', '-', '--', 1, {}]) {
    const result = slugifyTag(bad);
    assert.ok(result === null || typeof result === 'string');
  }
  assert.equal(slugifyTag('a'.repeat(200)).length, 48, 'слаг обрезается');
  assert.equal(slugifyTag('  Sword   Fight!!  '), 'sword-fight');
});

test('B7 · профиль вкуса чинится из любого мусора', () => {
  for (const bad of [null, undefined, 0, '', [], { tagWeights: null }, { foo: 'bar' }]) {
    const p = hydrateProfile(bad);
    assert.ok(p.tagWeights && typeof p.tagWeights === 'object');
    assert.ok(p.counts.like === 0 || typeof p.counts.like === 'number');
    assert.equal(p.moods, undefined);
  }
});

test('B8 · неизвестное действие не портит профиль', () => {
  const base = applySignal(createEmptyProfile(), LIBRARY.inception, ACTION.LIKE);
  const after = applySignal(base, LIBRARY.inception, 'телепортация');
  assert.deepEqual(after.tagWeights, base.tagWeights, 'неизвестный сигнал игнорируется');
  assert.equal(applySignal(base, null, ACTION.LIKE).signals, base.signals);
});

test('B9 · словарь тегов не растёт бесконечно', () => {
  const config = RECOMMENDATION_CONFIG;
  const noisy = { tagWeights: {}, moods: { ...NEUTRAL_MOOD }, moodMass: 1, counts: {}, signals: 1 };
  for (let i = 0; i < 1000; i += 1) noisy.tagWeights[`tag-${i}`] = Math.random() * 10;

  const pruned = pruneProfile(hydrateProfile(noisy), config);
  assert.ok(Object.keys(pruned.tagWeights).length <= config.decay.maxTags,
    'профиль обязан быть ограничен по размеру');
});

test('B10 · старение профиля монотонно и не уходит в отрицательные веса', () => {
  let profile = applySignal(createEmptyProfile(), LIBRARY.sevenSamurai, ACTION.FAVORITE);
  const before = profile.tagWeights.samurai;

  const halfLife = RECOMMENDATION_CONFIG.decay.halfLifeDays;
  const aged = decayProfile(
    { ...profile, updatedAt: Date.now() - halfLife * 86_400_000 },
    { now: Date.now() },
  );
  assert.ok(aged.tagWeights.samurai < before * 0.6, 'за период полураспада вес падает примерно вдвое');
  assert.ok(aged.tagWeights.samurai > 0);

  const fresh = decayProfile(profile);
  assert.equal(fresh.tagWeights.samurai, before, 'свежий профиль не стареет');
});

test('B11 · пустая колода и пустой профиль не роняют ранжирование', () => {
  assert.deepEqual(rankDeck([], createEmptyProfile()), []);
  assert.deepEqual(rankDeck([null, undefined, {}], createEmptyProfile()), []);
  const deck = rankDeck(ALL_TITLES, createEmptyProfile(), { size: 5, random: seededRandom(1) });
  assert.equal(deck.length, 5, 'на холодном старте лента всё равно собирается');
});

test('B12 · история жёстко исключает то, что нельзя показывать', () => {
  const history = {
    [LIBRARY.inception.id]: 'dislike',
    [LIBRARY.ocean11.id]: 'watched',
    [LIBRARY.johnWick.id]: 'like',
  };
  const deck = rankDeck(ALL_TITLES, createEmptyProfile(), { history, size: 50, random: seededRandom(2) });
  const ids = deck.map((c) => c.id);
  assert.ok(!ids.includes(LIBRARY.inception.id), 'отклонённое не возвращается');
  assert.ok(!ids.includes(LIBRARY.ocean11.id), '«посмотрено» убрано из колоды');
  assert.ok(!ids.includes(LIBRARY.johnWick.id), 'уже лайкнутое не показывается повторно');

  assert.equal(scoreTitle(LIBRARY.inception, createEmptyProfile(), { history }).score, 0);
});

test('B13 · размер колоды не превышает доступное количество тайтлов', () => {
  const deck = rankDeck(ALL_TITLES.slice(0, 3), createEmptyProfile(), { size: 100, random: seededRandom(4) });
  assert.equal(deck.length, 3);
  assert.equal(new Set(deck.map((c) => c.id)).size, 3, 'дубликатов быть не должно');
});

test('B14 · компромисс комнаты работает при одном и при нулевом участнике', () => {
  assert.equal(buildConsensusProfile([]).signals, 0);
  assert.equal(buildConsensusProfile(null).signals, 0);

  const solo = applySignal(createEmptyProfile(), LIBRARY.drive, ACTION.LIKE);
  const consensus = buildConsensusProfile([solo]);
  assert.deepEqual(consensus.tagWeights, solo.tagWeights, 'один участник — его собственный профиль');
});

test('B15 · активный участник не задавливает пассивного в комнате', () => {
  let heavy = createEmptyProfile();
  for (let i = 0; i < 80; i += 1) heavy = applySignal(heavy, LIBRARY.johnWick, ACTION.LIKE);
  const light = applySignal(createEmptyProfile(), LIBRARY.notebook, ACTION.LIKE);

  const consensus = buildConsensusProfile([heavy, light]);
  assert.ok(consensus.tagWeights.romance > 0,
    'тема «тихого» участника обязана выжить после нормализации');
});

test('B16 · идентификатор тайтла пригоден как ключ Postgres', () => {
  // В Postgres title_id — обычная колонка text, экранирование не нужно,
  // но формат обязан оставаться стабильным: на него завязаны первичные
  // ключи room_swipes, room_matches и title_history.
  const id = makeTitleId(603);
  assert.equal(id, 'tmdb:movie:603');
  assert.deepEqual(parseTitleId(id), { source: 'tmdb', kind: 'movie', externalId: '603' });
  assert.ok(id.length <= 64, 'идентификатор должен оставаться коротким');
});

test('B17 · ключ кэша не выносит запрещённых символов и ограничен по длине', () => {
  const key = cacheKeyFor('discover', { 'primary_release_date.gte': '1970-01-01', page: 1, empty: '' });
  assert.ok(!/[.#$/[\]]/.test(key), `ключ содержит запрещённый символ: ${key}`);
  assert.ok(key.length <= 180);
  assert.ok(!key.includes('empty'), 'пустые параметры не попадают в ключ');
  assert.equal(cacheKeyFor('x', { a: 1, b: 2 }), cacheKeyFor('x', { b: 2, a: 1 }),
    'порядок параметров не должен менять ключ');
});

test('B18 · просроченный initData отклоняется', () => {
  const botToken = 'bot:token';
  const stale = Math.floor(Date.now() / 1000) - 60 * 60 * 48;
  const params = new URLSearchParams({
    auth_date: String(stale),
    user: JSON.stringify({ id: 5, first_name: 'Ян' }),
  });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));

  assert.throws(() => validateInitData(params.toString(), { botToken }), /устарела/i);
  // С расширенным окном тот же пакет проходит — проверка именно на возраст.
  const ok = validateInitData(params.toString(), { botToken, maxAgeSeconds: 60 * 60 * 72 });
  assert.equal(ok.telegramId, '5');
});

test('B19 · initData без пользователя и без подписи отклоняется', () => {
  assert.throws(() => validateInitData('', { botToken: 'x' }), /не передал/i);
  assert.throws(() => validateInitData('auth_date=1', { botToken: 'x' }), /подпись/i);
  assert.throws(() => validateInitData(null, { botToken: 'x' }), /не передал/i);
});

/**
 * Регрессия на реальный сбой: токен, скопированный в панель хостинга,
 * приезжает с переводом строки на конце. Секрет HMAC от этого меняется
 * целиком, подпись не сходится ни у кого, а по симптому это неотличимо
 * от «Telegram сломался».
 */
test('B19a · токен бота из окружения читается без окружающих пробелов', () => {
  const clean = '123456:AA-clean-token';
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = `  ${clean}\n`;
    assert.equal(readBotToken(), clean);
    assert.equal(botIdFromToken(), '123456');

    const params = signedInitData(clean, { id: 42, first_name: 'Ким' });
    // Подпись сходится, хотя в окружении лежит замусоренное значение.
    assert.equal(validateInitData(params).telegramId, '42');

    process.env.TELEGRAM_BOT_TOKEN = '   ';
    assert.equal(readBotToken(), null);
    assert.equal(botIdFromToken(), null);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

/**
 * Регрессия на боевой сбой: вход не работал ни у кого.
 *
 * Свежие клиенты добавляют в initData поле `signature` (Ed25519 для
 * сторонней проверки) и включают его в подписываемую строку — сервер же
 * его выбрасывал, и подпись не сходилась никогда. Часть SDK, наоборот,
 * signature исключает, так что проходить обязаны оба варианта.
 *
 * Тест намеренно строит подпись независимо от кода валидации: прошлый
 * вариант генерировал её тем же выражением, что и проверял, и потому
 * подтверждал сам себя, а не совместимость с Telegram.
 */
test('B19b · подпись сходится и с signature внутри строки, и без него', () => {
  const token = '999:sig-token';
  const user = { id: 7, first_name: 'Лев' };

  const included = signedInitData(token, user, { signature: 'ed25519-payload' }, { signSignature: true });
  assert.equal(validateInitData(included, { botToken: token }).telegramId, '7',
    'клиент включил signature в подпись — так делает сам Telegram');

  const excluded = signedInitData(token, user, { signature: 'ed25519-payload' }, { signSignature: false });
  assert.equal(validateInitData(excluded, { botToken: token }).telegramId, '7',
    'клиент signature не подписывал — так делает часть SDK');

  // Подмена значения ломает подпись в обоих вариантах: перебор строк
  // не должен превращаться в дырку.
  const tampered = included.replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ id: 66 }))}`);
  assert.throws(() => validateInitData(tampered, { botToken: token }), /подпись/i);
});

/**
 * Подписанный initData, собранный вручную по спецификации Telegram.
 * @param {{signSignature?: boolean}} mode включать ли `signature` в data_check_string
 */
function signedInitData(token, user, extra = {}, { signSignature = true } = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
    ...extra,
  });
  const dcs = [...params.entries()]
    .filter(([k]) => (signSignature ? true : k !== 'signature'))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

test('B19c · ник Telegram приводится к формату MatchWatch или отбрасывается', () => {
  assert.equal(usernameFromTelegram('@SaintRose'), 'saintrose');
  assert.equal(usernameFromTelegram('Ann_2000'), 'ann_2000');
  // Кириллица и знаки вырезаются, длина режется до 24.
  assert.equal(usernameFromTelegram('Аня'), null);
  assert.equal(usernameFromTelegram('a'.repeat(32)), 'a'.repeat(24));
  for (const bad of [null, undefined, '', '  ', '@@', 'ab']) {
    assert.equal(usernameFromTelegram(bad), null, `«${bad}» не годится как ник`);
  }
});

test('B20 · сериализация профиля не пропускает NaN и undefined в базу', () => {
  const dirty = hydrateProfile({
    tagWeights: { good: 1.5, bad: NaN, missing: undefined },
    moods: { energy: NaN, darkness: 70 },
    signals: 3,
  });
  const serialized = serializeProfile(dirty);
  assert.equal(serialized.tagWeights.bad, undefined, 'NaN не должен уехать в базу');
  assert.equal(serialized.moods, undefined, 'вектора настроения в профиле больше нет');
  assert.equal(serialized.moodMass, undefined);
  assert.ok(JSON.stringify(serialized).length > 0);
});

test('B21 · тайтл без тегов не ломает подсветку совпадений', () => {
  assert.deepEqual(matchedTags(undefined, { a: 1 }), []);
  assert.deepEqual(matchedTags({ a: 1 }, undefined), []);
  const naked = makeTitle(900, 'Без тегов', { genres: [], keywords: [] });
  const evaluation = scoreTitle(naked, createEmptyProfile());
  assert.ok(Number.isFinite(evaluation.score));
  assert.deepEqual(evaluation.matchedTags, []);
});

test('B22 · слияние конфига переопределяет только заданное', () => {
  const merged = mergeConfig(RECOMMENDATION_CONFIG, { exploration: { rate: 0.5 }, blend: undefined });
  assert.equal(merged.exploration.rate, 0.5);
  assert.equal(merged.exploration.coldStartRate, RECOMMENDATION_CONFIG.exploration.coldStartRate,
    'соседние поля не должны потеряться');
  assert.equal(merged.blend.tagWeight, RECOMMENDATION_CONFIG.blend.tagWeight);
  assert.deepEqual(mergeConfig(RECOMMENDATION_CONFIG, null), RECOMMENDATION_CONFIG);
});

test('B23 · вспомогательные функции границ', () => {
  assert.equal(clamp(-5, 0, 100), 0);
  assert.equal(clamp(500, 0, 100), 100);
  assert.equal(clamp(50, 0, 100), 50);
  assert.equal(parseTitleId('битый-ид'), null);
  assert.equal(parseTitleId(null), null);
  assert.equal(profileBreadth(createEmptyProfile()), 0);
  assert.equal(isWarm(createEmptyProfile()), false);
  assert.deepEqual(topTags(null), []);
});

test('B24 · веса тегов у тайтла ограничены сверху', () => {
  // Фильм с двадцатью пересекающимися ключевыми словами не должен
  // получить тег весом 400 и утащить всю ленту.
  const tags = buildTags({
    genreIds: [28, 18, 36],
    keywords: Array.from({ length: 20 }, () => 'samurai'),
  });
  for (const weight of Object.values(tags)) {
    assert.ok(weight <= 100, `вес тега ${weight} превысил максимум`);
  }
});

test('B25 · HTML вместо JSON распознаётся как отсутствующий бэкенд', async () => {
  // Статический хостинг отдаёт SPA на /api/* с кодом 200. Раньше такой
  // ответ проходил как успешный и всплывал невнятным TypeError дальше.
  const { api } = await import('../src/lib/api.js');
  const original = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    json: async () => { throw new SyntaxError('Unexpected token <'); },
  });

  try {
    await assert.rejects(() => api.catalog({ page: 99 }), (error) => {
      assert.equal(error.code, 'api_unavailable');
      assert.equal(error.retryable, false);
      assert.match(error.message, /вместо данных/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('B26 · отклонённый фильм не возвращается в колоду ни при каких условиях', async () => {
  const { rankDeck, isDecided, DECIDED_STATES } = await import('../src/engine/ranking.js');

  // Все состояния, означающие принятое решение, обязаны исключать тайтл.
  for (const state of DECIDED_STATES) {
    const deck = rankDeck(ALL_TITLES, createEmptyProfile(), {
      history: { [LIBRARY.inception.id]: state },
      size: ALL_TITLES.length,
      random: seededRandom(5),
    });
    assert.ok(!deck.some((c) => c.id === LIBRARY.inception.id),
      `состояние «${state}» обязано убирать фильм из выбора`);
    assert.equal(isDecided(state), true);
  }

  // А вот «показали, но решения не приняли» — не решение: фильм вернётся.
  const seenOnly = rankDeck(ALL_TITLES, createEmptyProfile(), {
    history: { [LIBRARY.inception.id]: 'seen' },
    size: ALL_TITLES.length,
    random: seededRandom(5),
  });
  assert.ok(seenOnly.some((c) => c.id === LIBRARY.inception.id),
    'просто показанная карточка должна иметь право появиться снова');
  assert.equal(isDecided('seen'), false);
});

test('B27 · пустая история означает «ещё не загружено», а не «решений нет»', async () => {
  const { rankDeck } = await import('../src/engine/ranking.js');

  // Именно здесь пряталась ошибка: колода собиралась до прихода истории,
  // и всё отклонённое возвращалось в ленту. Проверка фиксирует разницу
  // между «истории нет» и «история пуста».
  const withoutHistory = rankDeck(ALL_TITLES, createEmptyProfile(), {
    size: ALL_TITLES.length, random: seededRandom(9),
  });
  const withHistory = rankDeck(ALL_TITLES, createEmptyProfile(), {
    history: { [LIBRARY.inception.id]: 'dislike' },
    size: ALL_TITLES.length,
    random: seededRandom(9),
  });

  assert.equal(withoutHistory.length, ALL_TITLES.length,
    'без истории движок не может ничего исключить — потому её и нужно дождаться');
  assert.equal(withHistory.length, ALL_TITLES.length - 1);
});

test('B28 · свайп снимает ровно одну карточку, даже если её уже убрал фильтр', async () => {
  const { advanceQueue } = await import('../src/hooks/useDeck.js');
  const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  // Обычный случай: решение по верхней карточке.
  assert.deepEqual(advanceQueue(queue, 'a').map((e) => e.id), ['b', 'c', 'd']);

  /*
   * Гонка, из-за которой лента «мерцала»: решение записывается в историю
   * синхронно, фильтр решённых успевает убрать карточку, и только потом
   * приходит снятие. Слепой сдвиг съедал бы следующую — под верхней
   * карточкой подменялся фильм.
   */
  const alreadyPurged = queue.filter((e) => e.id !== 'a');
  assert.deepEqual(advanceQueue(alreadyPurged, 'a').map((e) => e.id), ['b', 'c', 'd'],
    'повторное снятие не должно трогать очередь');

  // Снятие не с начала очереди тоже не задевает соседей.
  assert.deepEqual(advanceQueue(queue, 'c').map((e) => e.id), ['a', 'b', 'd']);

  assert.deepEqual(advanceQueue([], 'a'), []);
  assert.deepEqual(advanceQueue(queue).map((e) => e.id), ['b', 'c', 'd'],
    'без идентификатора снимается первая — запасное поведение');
});

test('B29 · неудачная запись не теряется, а досылается при возврате сети', async () => {
  // Подменяем окружение браузера: очередь живёт в localStorage.
  const store = new Map();
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const { registerHandler, durableWrite, flushOutbox, pendingCount, __resetOutbox } =
    await import('../src/lib/outbox.js');

  __resetOutbox();
  let networkDown = true;
  const delivered = [];
  registerHandler('probe', async (payload) => {
    if (networkDown) throw new Error('сеть недоступна');
    delivered.push(payload.value);
  });

  await durableWrite('probe', { value: 'первое' }, { key: 'title:1' });
  await durableWrite('probe', { value: 'другое' }, { key: 'title:2' });
  assert.equal(pendingCount(), 2, 'неудачные записи обязаны попасть в очередь');

  // Повторное решение по тому же фильму заменяет прежнее: в очереди
  // должно лежать последнее состояние, а не история изменений.
  await durableWrite('probe', { value: 'исправленное' }, { key: 'title:1' });
  assert.equal(pendingCount(), 2, 'повтор по тому же ключу не должен раздувать очередь');

  networkDown = false;
  const result = await flushOutbox();

  assert.equal(result.sent, 2);
  assert.equal(result.left, 0);
  assert.equal(pendingCount(), 0, 'после доставки очередь пуста');
  assert.ok(delivered.includes('исправленное'), 'доставлено должно быть последнее решение');
  assert.ok(!delivered.includes('первое'), 'устаревшее решение отправлять не нужно');
});

/**
 * Регрессия на дорогую догрузку.
 *
 * Каждая следующая порция колоды комнаты начиналась с нуля: новый пул,
 * три сотни карточек, два десятка обогащений — и так на каждые двадцать
 * пять фильмов. На телефоне это грело корпус. Переданный пул обязан
 * листаться дальше, а не пересобираться.
 */
test('B26 · догрузка колоды переиспользует пул, а не собирает его заново', async () => {
  const { buildRoomDeck } = await import('../src/engine/roomDeck.js');

  const titles = Array.from({ length: 80 }, (_, i) => makeTitle(500000 + i, `Фильм ${i}`));
  const calls = { fill: 0, enrich: 0, loadMore: 0 };

  const fakePool = {
    all: titles,
    size: titles.length,
    exhausted: true,
    async fill() { calls.fill += 1; },
    async enrich() { calls.enrich += 1; },
    async loadMore() { calls.loadMore += 1; },
  };

  const { deck, pool } = await buildRoomDeck({
    consensus: createEmptyProfile(),
    filters: {},
    history: {},
    pool: fakePool,
    size: 25,
  });

  assert.equal(calls.fill, 0, 'готовый пул не наполняется заново');
  assert.equal(calls.enrich, 0, 'и не обогащается повторно');
  assert.equal(pool, fakePool, 'пул возвращается для следующей догрузки');
  assert.ok(deck.length > 0, 'порция всё же собралась');

  // Уже отданное не повторяется: иначе колода «растёт» одними и теми же.
  const again = await buildRoomDeck({
    consensus: createEmptyProfile(),
    filters: {},
    history: {},
    pool: fakePool,
    excludeIds: deck.map((e) => e.title.id),
    size: 25,
  });
  const overlap = again.deck.filter((e) => deck.some((d) => d.title.id === e.title.id));
  assert.equal(overlap.length, 0, 'вторая порция не повторяет первую');
});

test('B33 · личная история не режет общую колоду комнаты', async () => {
  const { pruneDecided, DECK_MODE } = await import('../src/hooks/useDeck.js');

  const deck = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}` }));

  /*
   * У двоих в комнате истории разные — и раньше каждый вычитал свою
   * из общей колоды. Из одних и тех же двадцати пяти карточек у одного
   * оставалась одна, у другого три, и оба упирались в «колода
   * закончилась», хотя колода была цела.
   */
  const mine = { t1: 'watched', t2: 'dislike', t3: 'favorite' };
  const hers = { t5: 'later' };

  assert.equal(pruneDecided(deck, mine, DECK_MODE.ROOM).length, 25,
    'общая колода одна на всех и личной историей не режется');
  assert.equal(pruneDecided(deck, hers, DECK_MODE.ROOM).length, 25);
  assert.deepEqual(
    pruneDecided(deck, mine, DECK_MODE.ROOM),
    pruneDecided(deck, hers, DECK_MODE.ROOM),
    'у обоих участников набор обязан совпадать карточка в карточку',
  );

  // Вне комнаты страховка обязана работать как прежде.
  const solo = pruneDecided(deck, mine, DECK_MODE.SOLO);
  assert.equal(solo.length, 22, 'в личной ленте решённое убирается');
  assert.equal(solo[0].id, 't0', 'верхняя карточка не трогается никогда');
});

test('B34 · разбор фразы не придумывает требований за человека', async () => {
  const { requestFromInterpretation } = await import('../shared/ai/interpretation.js');

  /*
   * Молчание — не требование. Если про мрачность в запросе ничего нет,
   * ось darkness не должна появиться: приписать человеку требование,
   * которого он не выдвигал, значит отвергнуть половину каталога
   * по причине, которую он не называл.
   */
  const light = requestFromInterpretation({
    summary: 'Ищем лёгкое',
    axes: { energy: 70 },
    tags: [],
  });
  assert.deepEqual(Object.keys(light.axes), ['energy']);

  // Пустой ответ остаётся пустым, а не превращается в нейтральные 50.
  const empty = requestFromInterpretation({ summary: '', axes: {}, tags: [] });
  assert.deepEqual(empty.axes, {});
  assert.deepEqual(empty.tags, []);
});

test('B35 · выдуманные моделью теги отбрасываются, а не уходят в запрос', async () => {
  const { requestFromInterpretation, AI_TAG_VOCABULARY } = await import('../shared/ai/interpretation.js');

  const real = AI_TAG_VOCABULARY[0];
  const result = requestFromInterpretation({
    summary: 'проверка',
    axes: {},
    tags: [
      { tag: real, weight: 1 },
      { tag: 'совершенно-выдуманный-тег', weight: 1 },
      { tag: 'another-invented-one', weight: 0.5 },
    ],
  });

  assert.deepEqual(result.tags.map((t) => t.tag), [real],
    'в запрос попадают только теги из словаря');
  assert.equal(result.dropped.length, 2, 'отброшенные названы — по ним видно, чего не хватает словарю');
});

test('B36 · тег двигает подборку даже когда его нет ни на одном фильме', async () => {
  const { requestFromInterpretation } = await import('../shared/ai/interpretation.js');

  /*
   * Главная гарантия результата. Ниже жанрового слоя теги в каталоге
   * почти пусты, зато вектор настроения есть у каждого тайтла. Поэтому
   * выбранный тег обязан превращаться в сдвиг по осям — иначе запрос
   * вроде «до слёз» тихо не сделал бы ничего.
   */
  const tearjerker = requestFromInterpretation({
    summary: 'Поплакать',
    axes: {},
    tags: [{ tag: 'tearjerker', weight: 1 }],
  });

  assert.ok(tearjerker.axes.emotion > 70,
    `эмоциональность должна вырасти, получили ${tearjerker.axes.emotion}`);
  assert.ok(Object.keys(tearjerker.axes).length > 0, 'оси не могут остаться пустыми');
});

test('B37 · названная моделью ось побеждает выведенную из тегов', async () => {
  const { requestFromInterpretation } = await import('../shared/ai/interpretation.js');

  // Прямое утверждение сильнее производного: модель сказала «энергия 20»,
  // и тег «без передышки» это не переспорит.
  const result = requestFromInterpretation({
    summary: 'проверка',
    axes: { energy: 20 },
    tags: [{ tag: 'relentless', weight: 1 }],
  });

  assert.equal(result.axes.energy, 20);
  // А оси, о которых модель промолчала, тег заполняет.
  assert.ok(result.axes.dynamism > 50, 'динамизм пришёл из тега');
});

test('B38 · жёсткими фильтрами становится только названное прямо', async () => {
  const { requestFromInterpretation } = await import('../shared/ai/interpretation.js');

  const ok = requestFromInterpretation({
    summary: '', axes: {}, tags: [],
    filters: { yearFrom: 2010, yearTo: 2020, maxRuntime: 120, minRating: 7, genres: ['35'] },
  });
  assert.deepEqual(ok.filters,
    { yearFrom: 2010, yearTo: 2020, maxRuntime: 120, minRating: 7, genres: ['35'] });

  // Мусор отсекается: пустой каталог хуже, чем проигнорированное условие.
  const junk = requestFromInterpretation({
    summary: '', axes: {}, tags: [],
    filters: { yearFrom: 1200, yearTo: 3000, maxRuntime: 5, minRating: 99, genres: ['нету', '35'] },
  });
  assert.deepEqual(junk.filters, { genres: ['35'] });

  // Перепутанные границы разворачиваются, а не отдают пустоту.
  const swapped = requestFromInterpretation({
    summary: '', axes: {}, tags: [], filters: { yearFrom: 2020, yearTo: 2010 },
  });
  assert.deepEqual(swapped.filters, { yearFrom: 2010, yearTo: 2020 });
});

test('B39 · сказанное словами складывается с чипами, а не заменяет их', async () => {
  const { buildMoodRequest, REWATCH } = await import('../shared/config/moodPresets.js');

  const chipsOnly = buildMoodRequest({ keys: ['laugh'], ai: null });
  const bothSaid = buildMoodRequest({
    keys: ['laugh'],
    ai: { axes: { energy: 20, intellect: 80 }, tags: [], summary: 'но не тупое' },
  });

  /*
   * Это один человек, сказавший одно желание двумя способами: выбрал
   * «Посмеяться» и дописал «но не тупое». Отдать победу одному из них
   * значило бы выбросить половину сказанного.
   */
  assert.ok(bothSaid.axes.energy < chipsOnly.axes.energy,
    'ось, названную обоими, усредняем');
  assert.equal(bothSaid.axes.intellect, 80,
    'ось, названную только словами, берём как есть');
  assert.equal(bothSaid.summary, 'но не тупое');

  // Пересмотр остаётся кнопкой и разбору не отдаётся.
  assert.equal(buildMoodRequest({ keys: [REWATCH], ai: null }).rewatch, true);
  assert.equal(buildMoodRequest({ keys: [], ai: { axes: {}, tags: [] } }).rewatch, false);

  // Старый формат — просто массив ключей — обязан работать по-прежнему.
  assert.deepEqual(buildMoodRequest(['laugh']).axes, chipsOnly.axes);
});

test('B40 · условия участников складываются так, чтобы колода не опустела', async () => {
  const { mergeRequestFilters } = await import('../shared/ai/interpretation.js');

  // Длительность — по строгому: фильм длиннее того, что один готов
  // высидеть, плох для обоих.
  assert.equal(mergeRequestFilters([
    { filters: { maxRuntime: 120 } },
    { filters: { maxRuntime: 180 } },
  ]).maxRuntime, 120);

  // Названное одним применяется, когда второй промолчал.
  assert.equal(mergeRequestFilters([
    { filters: { maxRuntime: 120 } },
    { filters: {} },
  ]).maxRuntime, 120);

  /*
   * Жанры — объединением. Пересечение «комедии» и «ужасов» пусто,
   * а пустая колода означает, что вечер не состоится вовсе.
   */
  assert.deepEqual(mergeRequestFilters([
    { filters: { genres: ['35'] } },
    { filters: { genres: ['27'] } },
  ]).genres, ['35', '27']);

  // Годы пересекаются, когда пересечение существует…
  assert.deepEqual(mergeRequestFilters([
    { filters: { yearFrom: 2000, yearTo: 2020 } },
    { filters: { yearFrom: 2010, yearTo: 2030 } },
  ]), { yearFrom: 2010, yearTo: 2020 });

  // …и расходятся на общий размах, когда не существует.
  assert.deepEqual(mergeRequestFilters([
    { filters: { yearFrom: 1990, yearTo: 1999 } },
    { filters: { yearFrom: 2015, yearTo: 2020 } },
  ]), { yearFrom: 1990, yearTo: 2020 });

  assert.deepEqual(mergeRequestFilters([]), {});
  assert.deepEqual(mergeRequestFilters([{ filters: {} }]), {});
});

test('B41 · просьба чего-то избежать действительно понижает такие фильмы', async () => {
  const { avoidancePenalty, mergeAvoided } = await import('../shared/ai/interpretation.js');

  /*
   * Появилось после живой проверки: модель писала «исключая болезни»,
   * а выразить это ей было нечем — и фильм про болезнь спокойно попадал
   * в подборку. Обещание в тексте без механизма замечает первый же
   * зритель, получивший ровно то, от чего отказывался.
   */
  const avoid = [{ tag: 'illness', weight: 1 }];

  assert.ok(avoidancePenalty({ illness: 90, drama: 70 }, avoid) < 0.3,
    'фильм, где это главная тема, уходит вниз');
  assert.ok(avoidancePenalty({ illness: 20, comedy: 90 }, avoid) > 0.7,
    'мимоходом упомянутая тема — не то же самое');
  assert.equal(avoidancePenalty({ comedy: 90 }, avoid), 1,
    'не задевающий фильм не наказывается вовсе');

  // Отсева нет намеренно: жёсткий фильтр по тегу выбросил бы заодно
  // всё неразмеченное, то есть почти весь каталог.
  assert.ok(avoidancePenalty({ illness: 100 }, avoid) > 0,
    'даже задетый фильм остаётся возможным, просто маловероятным');

  assert.equal(avoidancePenalty({ illness: 100 }, []), 1);
  assert.equal(avoidancePenalty(null, avoid), 1);

  // Просьбу одного уважают все: отказы участников складываются.
  assert.deepEqual(
    mergeAvoided([
      { avoid: [{ tag: 'illness', weight: 0.5 }] },
      { avoid: [{ tag: 'illness', weight: 1 }, { tag: 'gore', weight: 0.8 }] },
    ]),
    [{ tag: 'illness', weight: 1 }, { tag: 'gore', weight: 0.8 }],
    'по каждой теме берётся самая настойчивая просьба',
  );
});

test('B42 · неполная разметка не принимается', async () => {
  const { normalizeMarkup } = await import('../shared/ai/markup.js');
  const { MOOD_AXES } = await import('../shared/config/recommendation.js');

  const full = Object.fromEntries(MOOD_AXES.map((a) => [a, 70]));

  /*
   * Достроить недостающую ось до нейтральных пятидесяти значило бы
   * выдать догадку за измерение — а именно на этих числах потом
   * строится вся подборка.
   */
  const partial = { ...full };
  delete partial[MOOD_AXES[0]];
  assert.equal(normalizeMarkup({ tags: [{ tag: 'drama', weight: 80 }], moods: partial }), null,
    'вектор без одной оси — не вектор');

  assert.equal(normalizeMarkup({ tags: [], moods: full }), null,
    'разметка без тегов бесполезна');

  const ok = normalizeMarkup({ tags: [{ tag: 'drama', weight: 80 }], moods: full, confidence: 'low' });
  assert.deepEqual(ok.tags, { drama: 80 });
  assert.equal(ok.confidence, 'low');
});

test('B43 · выдуманные теги в разметку не попадают', async () => {
  const { normalizeMarkup, MARKUP_VOCABULARY } = await import('../shared/ai/markup.js');
  const { MOOD_AXES } = await import('../shared/config/recommendation.js');
  const moods = Object.fromEntries(MOOD_AXES.map((a) => [a, 50]));

  const result = normalizeMarkup({
    moods,
    tags: [
      { tag: MARKUP_VOCABULARY[0], weight: 90 },
      { tag: 'выдуманный-тег', weight: 90 },
    ],
  });

  assert.deepEqual(Object.keys(result.tags), [MARKUP_VOCABULARY[0]]);
  assert.deepEqual(result.dropped, ['выдуманный-тег'],
    'отброшенное называется — по нему видно, чего не хватает словарю');
});

test('B44 · настоящие теги TMDB главнее того, что придумала модель', async () => {
  const { applyMarkup } = await import('../shared/ai/markup.js');

  /*
   * Ключевые слова TMDB — факт, разметка модели — предположение.
   * Там, где они спорят о весе, побеждает факт; разметка добавляет
   * то, чего в TMDB не было вовсе.
   */
  const title = { id: 'x', tags: { drama: 90 }, moods: { energy: 50 } };
  const merged = applyMarkup(title, {
    tags: { drama: 30, 'slow-burn': 80 },
    moods: { energy: 20, darkness: 85 },
    confidence: 'high',
  });

  assert.equal(merged.tags.drama, 90, 'вес из TMDB не понижается разметкой');
  assert.equal(merged.tags['slow-burn'], 80, 'новое от модели добавляется');
  assert.deepEqual(merged.moods, { energy: 20, darkness: 85 },
    'вектор заменяется целиком: прежний посчитан из тех же жанровых тегов');

  // Без разметки карточка обязана остаться собой.
  assert.deepEqual(applyMarkup(title, null), title);
  assert.deepEqual(applyMarkup(title, { moods: {} }), title);
});



test('B47 · решение человека главнее и TMDB, и модели', async () => {
  const { applyCurated, russianEra } = await import('../shared/model/curated.js');
  const { applyMarkup } = await import('../shared/ai/markup.js');

  const fromTmdb = { id: 'x', tags: { comedy: 80 }, moods: { energy: 50 }, rating: 7.2 };

  const withModel = applyMarkup(fromTmdb, {
    tags: { comedy: 60, satire: 70 },
    moods: { energy: 70, darkness: 30 },
    confidence: 'high',
  });

  const final = applyCurated(withModel, {
    forceTags: ['russian-soviet'],
    imdbRating: 8.3,
    imdbVotes: 12000,
    collection: 'russian',
    era: 'soviet',
  });

  /*
   * Принудительный тег ставится с полным весом: «это наше кино» —
   * не наблюдение модели над описанием, а факт, который человек знает
   * и без неё. Никакая переразметка его не снимет.
   */
  assert.equal(final.tags['russian-soviet'], 100);
  assert.equal(final.tags.comedy, 80, 'вес TMDB сохранился');
  assert.equal(final.tags.satire, 70, 'находка модели сохранилась');

  /*
   * Рейтинг IMDB — отдельным полем, а не подменой оценки TMDB: шкалы
   * разные, и подмена сделала бы несравнимыми карточки с ним и без него.
   */
  assert.equal(final.imdbRating, 8.3);
  assert.equal(final.rating, 7.2, 'оценка TMDB на месте');
  /*
   * Метка подборки не занимает поле `collection`: у TMDB там франшиза
   * («Брат (Коллекция)»), и заняв его, мы затирали бы настоящие данные.
   */
  assert.equal(final.curatedList, 'russian');
  assert.equal(final.collection, undefined, 'поле TMDB осталось нетронутым');

  // Без слоя карточка обязана остаться собой.
  assert.deepEqual(applyCurated(fromTmdb, null), fromTmdb);

  // Границей эпох служит распад СССР.
  assert.equal(russianEra(1968), 'soviet');
  assert.equal(russianEra(1991), 'soviet');
  assert.equal(russianEra(1997), 'modern');
});

test('B48 · имена в почти-совпадении читаются, а не перечисляются', async () => {
  const { listNames } = await import('../shared/i18n/plural.js');

  /*
   * Имена вместо «двое из трёх» намеренно: в комнате сидят знакомые
   * люди, и чьё именно мнение совпало — половина ответа на вопрос,
   * соглашаться ли.
   */
  assert.equal(listNames(['Аня']), 'Аня');
  assert.equal(listNames(['Аня', 'Егор']), 'Аня и Егор');
  assert.equal(listNames(['Аня', 'Егор', 'Саня']), 'Аня, Егор и ещё 1');
  assert.equal(listNames(['Аня', 'Егор', 'Саня', 'Даня']), 'Аня, Егор и ещё 2');

  // Без имён экран всё равно должен читаться.
  assert.equal(listNames([]), 'Кто-то');
  assert.equal(listNames(undefined), 'Кто-то');
  assert.equal(listNames([null, 'Аня']), 'Аня');
});

test('B49 · близость считается к ближайшему любимому, а не к среднему', async () => {
  const { affinityToLoved } = await import('../src/engine/affinity.js');

  /*
   * Суть замены центроида. Человек любит и мрачное, и лёгкое. Усреднение
   * дало бы центр между ними — и подборку из фильмов, не похожих ни на
   * один из двух. Максимум по любимым сохраняет обе ветки живыми.
   */
  const loved = [
    { id: 'grim', title: 'Брат', tags: { crime: 100, loner: 90 }, moods: { darkness: 80, energy: 50, intellect: 50, emotion: 50, dynamism: 50 } },
    { id: 'light', title: 'Кин-дза-дза', tags: { comedy: 100, absurdist: 90 }, moods: { darkness: 40, energy: 50, intellect: 50, emotion: 50, dynamism: 50 } },
  ];

  const grimCandidate = { id: 'x', tags: { crime: 95, loner: 85 }, moods: { darkness: 78, energy: 50, intellect: 50, emotion: 50, dynamism: 50 } };
  const lightCandidate = { id: 'y', tags: { comedy: 95, absurdist: 85 }, moods: { darkness: 42, energy: 50, intellect: 50, emotion: 50, dynamism: 50 } };
  const middling = { id: 'z', tags: { drama: 60 }, moods: { darkness: 60, energy: 50, intellect: 50, emotion: 50, dynamism: 50 } };

  const grim = affinityToLoved(grimCandidate, loved);
  const light = affinityToLoved(lightCandidate, loved);
  const mid = affinityToLoved(middling, loved);

  assert.ok(grim.score > 0.7, `мрачный кандидат должен попасть в «Брата», получили ${grim.score}`);
  assert.ok(light.score > 0.7, `лёгкий должен попасть в «Кин-дза-дзу», получили ${light.score}`);

  /*
   * Главная проверка: серединка проигрывает обоим краям. При усреднении
   * профиля было бы ровно наоборот — она лежала бы ближе всех к центру.
   */
  assert.ok(mid.score < grim.score && mid.score < light.score,
    `среднее не должно выигрывать: серединка ${mid.score}, края ${grim.score}/${light.score}`);

  // Объяснение называет конкретный фильм, а не «вектор».
  assert.equal(grim.best.title, 'Брат');
  assert.equal(light.best.title, 'Кин-дза-дза');

  // Без опор функция не падает и не выдумывает.
  assert.deepEqual(affinityToLoved(grimCandidate, []), { score: 0, best: null, alsoLike: [] });
});

test('B50 · похожее на отвергнутое понижается, но не запрещается', async () => {
  const { affinityToRefused } = await import('../src/engine/affinity.js');

  const refused = [{ id: 'r', tags: { superhero: 100, action: 90 }, moods: { darkness: 40, energy: 80, intellect: 30, emotion: 50, dynamism: 85 } }];

  const twin = { id: 'a', tags: { superhero: 95, action: 85 }, moods: { darkness: 42, energy: 78, intellect: 32, emotion: 50, dynamism: 83 } };
  const distant = { id: 'b', tags: { documentary: 90 }, moods: { darkness: 50, energy: 40, intellect: 80, emotion: 60, dynamism: 30 } };

  assert.ok(affinityToRefused(twin, refused) > 0.8, 'почти тот же фильм — высокая похожесть');
  assert.ok(affinityToRefused(distant, refused) < 0.4, 'непохожий не должен наказываться');
  assert.equal(affinityToRefused(twin, []), 0);
});

test('B51 · ускорение подбора не меняет ни опору, ни состав колоды', async () => {
  const { prepare, prepareAll, affinityToLoved } = await import('../src/engine/affinity.js');

  const pool = Array.from({ length: 220 }, (_, i) => `tag${i}`);
  const mk = (id) => {
    const tags = {};
    for (let i = 0; i < 8; i += 1) tags[pool[(id * 7 + i * 3) % 220]] = 40 + ((id + i) % 60);
    return {
      id: `t${id}`, tags,
      moods: {
        darkness: (id * 13) % 100, energy: (id * 7) % 100, intellect: (id * 11) % 100,
        emotion: (id * 5) % 100, dynamism: (id * 3) % 100,
      },
    };
  };

  const loved = Array.from({ length: 40 }, (_, i) => mk(i));
  const candidates = Array.from({ length: 400 }, (_, i) => mk(1000 + i));

  /*
   * Обратный индекс сравнивает кандидата только с теми опорами, с кем
   * у него есть общая тема. Проверяем, что от этого не меняется то,
   * что видит человек: выбранная опора и состав колоды.
   */
  const indexed = prepareAll(loved);
  const plain = loved.map(prepare);

  const byIndex = [];
  const byBrute = [];

  for (const candidate of candidates) {
    const fast = affinityToLoved(prepare(candidate), indexed);
    const slow = affinityToLoved(prepare(candidate), plain);

    assert.equal(fast.best?.id, slow.best?.id,
      `опора обязана совпадать: ${candidate.id}`);

    byIndex.push([candidate.id, fast.score]);
    byBrute.push([candidate.id, slow.score]);
  }

  const top = (rows) => rows.slice().sort((a, b) => b[1] - a[1]).slice(0, 25).map((r) => r[0]);
  assert.deepEqual(top(byIndex), top(byBrute),
    'первая двадцатка пятёрка обязана совпадать карточка в карточку');
});

test('B52 · у человека нет вектора настроения, у фильма — есть', async () => {
  const { createEmptyProfile, applySignal, serializeProfile, ACTION } = await import('../src/engine/tasteProfile.js');
  const { buildConsensusProfile } = await import('../src/engine/ranking.js');
  const { RECOMMENDATION_CONFIG } = await import('../shared/config/recommendation.js');

  const film = {
    id: 'f1', title: 'Фильм', tags: { drama: 90 },
    moods: { energy: 20, darkness: 90, intellect: 60, emotion: 80, dynamism: 15 },
  };

  /*
   * Вектор человека был усреднением всего вкуса в одну точку, и это
   * математически обречено на серость: любящий «Брата» (мрак 80) и
   * «Кин-дза-дзу» (мрак 40) получал центр в районе шестидесяти —
   * то есть подборку, не похожую ни на один из двух.
   */
  const profile = applySignal(createEmptyProfile(), film, ACTION.FAVORITE);
  assert.equal(profile.moods, undefined, 'настроение не должно накапливаться в профиле');
  assert.equal(profile.moodMass, undefined);
  assert.equal(serializeProfile(profile).moods, undefined, 'и не должно уезжать в базу');

  // У ФИЛЬМА вектор остаётся: он нужен для запроса «хочу сегодня мрачное».
  assert.equal(film.moods.darkness, 90);

  // В смешивании веса для него тоже быть не должно.
  assert.equal(RECOMMENDATION_CONFIG.blend.moodWeight, undefined);

  /*
   * Комната — то место, ради которого убирали в первую очередь.
   * Усреднение двух разных людей давало середину между ними: у него
   * мрак 80, у неё 40, комната искала шестьдесят.
   */
  const consensus = buildConsensusProfile([
    applySignal(createEmptyProfile(), film, ACTION.FAVORITE),
    applySignal(createEmptyProfile(), { ...film, id: 'f2', tags: { comedy: 90 } }, ACTION.FAVORITE),
  ]);
  assert.equal(consensus.moods, undefined, 'комната не усредняет настроение участников');
  assert.ok(Object.keys(consensus.tagWeights).length > 0, 'а темы по-прежнему складывает');
});

test('B53 · опоры берут теги из каталога, а не из снимка истории', async () => {
  const { resolveAnchors } = await import('../src/engine/userData.js');
  const { api } = await import('../src/lib/api.js');

  const original = api.enrich;
  let askedIds = [];

  api.enrich = async (ids) => {
    askedIds = [...askedIds, ...ids];
    return {
      titles: ids.map((id) => ({
        id: `tmdb:movie:${id}`,
        title: `Фильм ${id}`,
        tags: { drama: 80, crime: 60 },
        moods: { energy: 40, darkness: 70, intellect: 50, emotion: 60, dynamism: 30 },
      })),
    };
  };

  try {
    /*
     * В истории решений лежит компактная карточка: id, название, постер,
     * год. Тегов в ней нет НИКОГДА. Первая версия читала теги оттуда
     * и молча оставалась без опор у всех до единого — модель близости
     * не работала ни разу и не могла бы заработать.
     */
    const resolved = await resolveAnchors({
      loved: [{ id: 'tmdb:movie:111', title: 'Брат' }],
      refused: [{ id: 'tmdb:movie:222', title: 'Что-то' }],
    });

    assert.deepEqual(askedIds.sort(), [111, 222], 'полные карточки берутся из каталога');
    assert.equal(resolved.loved.length, 1);
    assert.ok(Object.keys(resolved.loved[0].tags).length > 0, 'у опоры обязаны быть теги');
    assert.ok(resolved.loved[0].moods, 'и вектор настроения фильма');
    assert.equal(resolved.refused.length, 1);
  } finally {
    api.enrich = original;
  }
});

test('B54 · опора без тегов отбрасывается, а не ломает подбор', async () => {
  const { resolveAnchors } = await import('../src/engine/userData.js');
  const { api } = await import('../src/lib/api.js');

  const original = api.enrich;
  api.enrich = async (ids) => ({
    // Каталог знает фильм, но разметки у него ещё нет.
    titles: ids.map((id) => ({ id: `tmdb:movie:${id}`, title: `Ф${id}`, tags: {} })),
  });

  try {
    const resolved = await resolveAnchors({ loved: [{ id: 'tmdb:movie:5' }], refused: [] });
    assert.deepEqual(resolved.loved, [], 'мерить близость нечем — опорой быть не может');
  } finally {
    api.enrich = original;
  }

  // Пустой вход не должен ходить в сеть вовсе.
  assert.deepEqual(await resolveAnchors(null), { loved: [], refused: [] });
});

test('B55 · лента слушает сегодняшний вечер, но не сразу', async () => {
  const { createSessionMood, resortQueue } = await import('../src/engine/sessionMood.js');

  const mk = (id, tags, darkness) => ({
    id, tags,
    moods: { energy: 50, darkness, intellect: 50, emotion: 50, dynamism: 50 },
  });

  const session = createSessionMood();
  const grim = mk('g', { horror: 90, dread: 80 }, 85);
  const light = mk('l', { comedy: 90, 'feel-good': 80 }, 15);

  /*
   * Три свайпа — это не настроение вечера, а случайность. Рулить
   * по ним лентой значило бы дёргать её на ровном месте.
   */
  session.record(mk('a', { horror: 88 }, 84), false);
  session.record(mk('b', { horror: 86 }, 82), false);
  assert.equal(session.weigh(grim), 1, 'до порога лента не шевелится');

  // Отклонил шесть мрачных подряд — сегодня мрачного не хочется.
  for (let i = 0; i < 6; i += 1) {
    session.record(mk(`p${i}`, { horror: 85 + i, dread: 70 }, 80 + i), false);
  }
  for (let i = 0; i < 3; i += 1) {
    session.record(mk(`k${i}`, { comedy: 85 + i, 'feel-good': 70 }, 20), true);
  }

  assert.ok(session.weigh(grim) < 1, 'похожее на сегодняшние отказы опускается');
  assert.ok(session.weigh(light) > 1, 'похожее на сегодняшние «да» поднимается');

  // Верхние карточки не подменяются: человек их уже видит.
  const queue = [
    { id: 'top', score: 0.5, title: grim },
    { id: 'second', score: 0.5, title: grim },
    { id: 'x', score: 0.5, title: grim },
    { id: 'y', score: 0.4, title: light },
  ];
  const sorted = resortQueue(queue, session);
  assert.equal(sorted[0].id, 'top', 'верхняя карточка остаётся на месте');
  assert.equal(sorted[1].id, 'second');
  assert.equal(sorted[2].id, 'y', 'а в хвосте вперёд выходит то, что сегодня в тему');

  // Новый вечер — новое настроение.
  session.reset();
  assert.equal(session.weigh(grim), 1);
});

test('B56 · «мимо» и «нравится» доезжают до настроения вечера правильно', async () => {
  const { ACTION } = await import('../src/engine/tasteProfile.js');

  /*
   * Лента подстраивается по тому, чем было решение. Строка сравнения
   * должна совпадать с настоящим значением: опечатка здесь молча
   * превратила бы все отказы в одобрения, и вечер поехал бы ровно
   * в противоположную сторону.
   */
  assert.equal(ACTION.DISLIKE, 'dislike', 'значение действия «мимо» изменилось — проверьте SwipeDeck');
  assert.notEqual(ACTION.FAVORITE, 'dislike');
  assert.notEqual(ACTION.LATER, 'dislike');
  assert.notEqual(ACTION.WATCHED, 'dislike');
});

test('B57 · запасной отбор каталога повторяет условия discover, а не смягчает их', async () => {
  const { matchesFilters } = await import('../api/tmdb/catalog.js');

  const film = { genre_ids: [18, 80], release_date: '2014-05-01', vote_average: 7.4 };

  assert.ok(matchesFilters(film, {}), 'без условий проходит всё');

  /*
   * Жанры совпадают ПО ВСЕМ запрошенным, как в discover с перечислением
   * через запятую. «Или» вместо «и» вернуло бы человеку не то, что он
   * просил, и выглядело бы как сломанный фильтр, а не как запасной режим.
   */
  assert.ok(matchesFilters(film, { genres: ['18', '80'] }), 'оба жанра на месте');
  assert.ok(!matchesFilters(film, { genres: ['18', '27'] }), 'одного жанра не хватает — не подходит');

  assert.ok(!matchesFilters(film, { yearFrom: 2015 }), 'вышел раньше нижней границы');
  assert.ok(!matchesFilters(film, { yearTo: 2013 }), 'вышел позже верхней границы');
  assert.ok(matchesFilters(film, { yearFrom: 2010, yearTo: 2020 }), 'попадает в диапазон');

  assert.ok(!matchesFilters(film, { minRating: 8 }), 'оценка ниже требуемой');
  assert.ok(matchesFilters(film, { minRating: 7 }), 'оценка проходит');

  // Без даты выхода год неизвестен: под ограничение по годам он не проходит.
  assert.ok(!matchesFilters({ genre_ids: [18] }, { yearFrom: 2000 }));
});
