/**
 * Уровень 3 — Cross-Feature Interactions.
 * Связи между фильтрами, каталогом, комнатами, профилем и телеметрией.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RECOMMENDATION_CONFIG, mergeConfig } from '../shared/config/recommendation.js';
import { createEmptyProfile, applySignal, ACTION } from '../src/engine/tasteProfile.js';
import { clearApiCache } from '../src/lib/api.js';
import { rankDeck, scoreTitle, buildConsensusProfile } from '../src/engine/ranking.js';
import { normalizeRoomCode, JOIN_SOURCE, roomPath } from '../shared/model/roomCode.js';
import { BIZ, MODULE } from '../shared/telemetry/events.js';
import { withHandler, ApiError, badRequest } from '../api/_lib/http.js';
import { tmdbFetch, assertNonEmpty } from '../api/_lib/tmdb.js';
import { LIBRARY, ALL_TITLES, makeTitle, seededRandom } from './helpers/fixtures.mjs';

/* ── Заглушки HTTP для проверки серверных хендлеров ───────────── */

function fakeReq({ method = 'GET', url = '/api/test', body, headers = {} } = {}) {
  return { method, url, headers: { host: 'localhost', ...headers }, body };
}

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: null, writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(payload) { this.body = payload; this.writableEnded = true; },
  };
  return res;
}

const withMockedFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  // Клиент API кэширует ответы — между сценариями кэш надо сбрасывать,
  // иначе второй тест увидит данные первого.
  clearApiCache();
  try { return await fn(); } finally { globalThis.fetch = original; clearApiCache(); }
};

/* ── Тесты ───────────────────────────────────────────────────── */

test('X1 · фильтры сужают колоду, но не ломают ранжирование', () => {
  let profile = createEmptyProfile();
  profile = applySignal(profile, LIBRARY.sevenSamurai, ACTION.FAVORITE);

  // Фильтр применяется до движка — эмулируем «только фильмы после 2000».
  const filtered = ALL_TITLES.filter((t) => t.year >= 2000);
  const deck = rankDeck(filtered, profile, { size: 10, random: seededRandom(11) });

  assert.ok(deck.length > 0);
  assert.ok(deck.every((c) => c.title.year >= 2000), 'фильтр не должен протекать');
  assert.equal(deck[0].title.title, '13 убийц', 'внутри фильтра порядок задаёт вкус');
});

test('X2 · пустой результат после фильтров даёт пустую колоду, а не мусор', () => {
  const impossible = ALL_TITLES.filter((t) => t.year > 2100);
  assert.deepEqual(rankDeck(impossible, createEmptyProfile()), []);
  assert.deepEqual(assertNonEmpty([], { path: '/discover/movie', params: {} }), [],
    'пустой ответ TMDB — это бизнес-сбой, а не исключение');
});

test('X3 · избранное двигает выдачу сильнее, чем «желаемое» того же фильма', () => {
  const wished = applySignal(createEmptyProfile(), LIBRARY.ocean11, ACTION.LATER);
  const favorited = applySignal(createEmptyProfile(), LIBRARY.ocean11, ACTION.FAVORITE);

  const rankOf = (profile) => rankDeck(ALL_TITLES, profile, {
    size: 15, explorationRate: 0, random: seededRandom(5),
  }).findIndex((c) => c.id === LIBRARY.inception.id);

  assert.ok(rankOf(favorited) <= rankOf(wished),
    'после избранного родственный по тегам фильм должен быть не ниже');
  assert.ok(favorited.tagWeights.heist > wished.tagWeights.heist,
    'избранное обязано весить больше отложенного');
});

test('X4 · «посмотрено» в комнате убирает фильм из следующей общей колоды', () => {
  const consensus = buildConsensusProfile([
    applySignal(createEmptyProfile(), LIBRARY.sevenSamurai, ACTION.LIKE),
    applySignal(createEmptyProfile(), LIBRARY.ran, ACTION.LIKE),
  ]);

  const before = rankDeck(ALL_TITLES, consensus, { size: 20, random: seededRandom(6) });
  assert.ok(before.some((c) => c.id === LIBRARY.thirteenAssassins.id));

  const after = rankDeck(ALL_TITLES, consensus, {
    size: 20,
    history: { [LIBRARY.thirteenAssassins.id]: 'watched' },
    random: seededRandom(6),
  });
  assert.ok(!after.some((c) => c.id === LIBRARY.thirteenAssassins.id));
});

test('X5 · колода актёра игнорирует разведку и слушает вкус', () => {
  const profile = applySignal(createEmptyProfile(), LIBRARY.sevenSamurai, ACTION.FAVORITE);
  const filmography = [LIBRARY.paddington, LIBRARY.ran, LIBRARY.notebook, LIBRARY.harakiri];

  const deck = rankDeck(filmography, profile, { size: 4, explorationRate: 0, random: seededRandom(8) });
  assert.equal(deck.length, 4);
  assert.ok(deck.every((c) => c.slot === 'profile'), 'в колоде актёра разведке не место');
  assert.ok(['Харакири', 'Ран'].includes(deck[0].title.title));
});

test('X6 · удалённый конфиг меняет поведение движка без правки кода', () => {
  const profile = (() => {
    let p = createEmptyProfile();
    for (let i = 0; i < 40; i += 1) p = applySignal(p, LIBRARY.sevenSamurai, ACTION.LIKE);
    return p;
  })();

  const noExplore = mergeConfig(RECOMMENDATION_CONFIG, { exploration: { rate: 0 } });
  const allExplore = mergeConfig(RECOMMENDATION_CONFIG, { exploration: { rate: 0.9, minQuality: 0 } });

  const a = rankDeck(ALL_TITLES, profile, { config: noExplore, size: 10, random: seededRandom(9) });
  const b = rankDeck(ALL_TITLES, profile, { config: allExplore, size: 10, random: seededRandom(9) });

  assert.equal(a.filter((c) => c.slot === 'explore').length, 0);
  assert.ok(b.filter((c) => c.slot === 'explore').length > a.filter((c) => c.slot === 'explore').length);
});

test('X7 · веса смешивания реально управляют вкладом сигналов', () => {
  const profile = applySignal(createEmptyProfile(), LIBRARY.sevenSamurai, ACTION.FAVORITE);

  const tagHeavy = mergeConfig(RECOMMENDATION_CONFIG, { blend: { tagWeight: 1, moodWeight: 0, qualityWeight: 0 } });
  const qualityHeavy = mergeConfig(RECOMMENDATION_CONFIG, { blend: { tagWeight: 0, moodWeight: 0, qualityWeight: 1 } });

  const byTags = scoreTitle(LIBRARY.ran, profile, { config: tagHeavy });
  const byQuality = scoreTitle(LIBRARY.ran, profile, { config: qualityHeavy });

  /*
   * Сверяется оценка ДО штрафов: веса управляют смешиванием сигналов,
   * а история решений и поправка на популярность применяются поверх
   * и к смешиванию отношения не имеют.
   */
  assert.equal(byTags.rawScore, byTags.tagScore);
  assert.equal(byQuality.rawScore, byQuality.qualityScore);
  assert.notEqual(byTags.rawScore, byQuality.rawScore);
});

test('X8 · антимонотонность разбавляет однородную ленту', () => {
  const clones = Array.from({ length: 8 }, (_, i) =>
    makeTitle(200 + i, `Самурай ${i}`, { genres: [28], keywords: ['samurai', 'sword fight'], rating: 8 - i * 0.1 }));
  const others = [LIBRARY.notebook, LIBRARY.inception, LIBRARY.parasite, LIBRARY.drive];

  const profile = applySignal(createEmptyProfile(), LIBRARY.sevenSamurai, ACTION.FAVORITE);
  const deck = rankDeck([...clones, ...others], profile, {
    size: 12, explorationRate: 0, random: seededRandom(12),
  });

  const dominant = deck.slice(0, 6).map((c) => Object.entries(c.title.tags)
    .sort(([, a], [, b]) => b - a)[0][0]);
  const longestRun = dominant.reduce((acc, tag, i) => {
    const run = tag === dominant[i - 1] ? acc.current + 1 : 1;
    return { current: run, max: Math.max(acc.max, run) };
  }, { current: 0, max: 0 }).max;

  assert.ok(longestRun <= 5, `слишком длинная серия одинаковых тем: ${longestRun}`);
});

test('X9 · код комнаты одинаков независимо от способа входа', () => {
  const inputs = {
    [JOIN_SOURCE.MANUAL]: ' 40719 ',
    [JOIN_SOURCE.LINK]: 'https://matchwatch.app/?room=40719',
    [JOIN_SOURCE.DEEP_LINK]: 'https://t.me/bot/app?startapp=40719',
    [JOIN_SOURCE.RECENT]: '40719',
  };
  const codes = new Set(Object.values(inputs).map(normalizeRoomCode));
  assert.equal(codes.size, 1, 'все способы входа обязаны сойтись в один код');
  assert.equal([...codes][0], '40719');

  const paths = new Set(Object.values(inputs).map((raw) => roomPath(raw, 'swipes')));
  assert.equal(paths.size, 1, 'а значит, и путь записи/чтения совпадает');
  assert.equal([...paths][0], 'rooms/40719/swipes');
});

/**
 * Регрессия на боевую дыру: служебные эндпоинты были открыты всему
 * интернету. Проверка вида «если секрет задан — сверить» пропускала
 * запрос при незаполненной переменной, то есть забытая настройка молча
 * открывала уборку комнат и дашборд метрик.
 */
test('X9a · служебный секрет закрывает доступ, а не открывает', async () => {
  const { requireSecret } = await import('../api/_lib/http.js');
  const previous = process.env.X_TEST_SECRET;
  const query = new URLSearchParams();

  try {
    delete process.env.X_TEST_SECRET;
    assert.throws(() => requireSecret(fakeReq(), query, 'X_TEST_SECRET'),
      (e) => e.status === 503 && e.code === 'secret_not_configured',
      'без заданного секрета эндпоинт обязан быть закрыт');

    process.env.X_TEST_SECRET = 'правильный';

    assert.throws(() => requireSecret(fakeReq(), query, 'X_TEST_SECRET'),
      (e) => e.status === 401, 'без токена — отказ');

    assert.throws(
      () => requireSecret(fakeReq({ headers: { authorization: 'Bearer неправильный' } }), query, 'X_TEST_SECRET'),
      (e) => e.status === 401, 'с чужим токеном — отказ');

    // Совпадение длины, но не содержимого: сравнение обязано смотреть целиком.
    assert.throws(
      () => requireSecret(fakeReq({ headers: { authorization: 'Bearer правильныЙ' } }), query, 'X_TEST_SECRET'),
      (e) => e.status === 401);

    assert.doesNotThrow(
      () => requireSecret(fakeReq({ headers: { authorization: 'Bearer правильный' } }), query, 'X_TEST_SECRET'));

    query.set('token', 'правильный');
    assert.doesNotThrow(() => requireSecret(fakeReq(), query, 'X_TEST_SECRET'),
      'крон Vercel передаёт секрет параметром');
  } finally {
    if (previous === undefined) delete process.env.X_TEST_SECRET;
    else process.env.X_TEST_SECRET = previous;
  }
});

test('X9b · CORS не раздаёт доступ незнакомым сайтам', async () => {
  const handler = withHandler({ methods: ['GET'], module: MODULE.OPS }, async () => ({ ok: true }));

  const originFor = async (origin) => {
    const res = fakeRes();
    await handler(fakeReq({ headers: origin ? { origin } : {} }), res);
    return res.headers['access-control-allow-origin'];
  };

  // Свои развёртки и клиент Telegram — можно.
  assert.equal(await originFor('https://matchwatch-seven.vercel.app'), 'https://matchwatch-seven.vercel.app');
  assert.equal(await originFor('https://web.telegram.org'), 'https://web.telegram.org');

  /*
   * Чужой проект на Vercel — нельзя. Раньше сюда пускал суффикс
   * `.vercel.app`, то есть любой из миллионов чужих развёрток.
   */
  assert.notEqual(await originFor('https://evil-project.vercel.app'), 'https://evil-project.vercel.app');
  assert.notEqual(await originFor('https://example.com'), 'https://example.com');

  // И звёздочку незнакомцу не отдаём: отказ не должен превращаться
  // в разрешение для всех.
  assert.notEqual(await originFor('https://example.com'), '*');
});

test('X10 · обёртка хендлера отдаёт машиночитаемую ошибку вместо голого 500', async () => {
  const handler = withHandler({ methods: ['GET'], module: MODULE.TMDB_PROXY }, async () => {
    throw badRequest('bad_input', 'Параметр id обязателен');
  });

  const res = fakeRes();
  await handler(fakeReq(), res);

  assert.equal(res.statusCode, 400);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'bad_input');
  assert.equal(payload.error.retryable, false);
  assert.match(payload.error.message, /обязателен/);
});

test('X11 · внутренняя ошибка не утекает наружу подробностями', async () => {
  const handler = withHandler({ methods: ['GET'], module: MODULE.OPS }, async () => {
    throw new Error('SELECT * FROM secrets — стек с внутренностями');
  });

  const res = fakeRes();
  await handler(fakeReq(), res);

  assert.equal(res.statusCode, 500);
  const payload = JSON.parse(res.body);
  assert.equal(payload.error.code, 'internal_error');
  assert.ok(!payload.error.message.includes('SELECT'), 'внутренние детали не показываем пользователю');
  assert.equal(payload.error.retryable, true);
});

test('X12 · неподдерживаемый метод и preflight обрабатываются', async () => {
  const handler = withHandler({ methods: ['POST'], module: MODULE.OPS }, async () => ({ ok: true }));

  const preflight = fakeRes();
  await handler(fakeReq({ method: 'OPTIONS' }), preflight);
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);

  const wrongMethod = fakeRes();
  await handler(fakeReq({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

test('X13 · TMDB rate-limit приводит к повтору, а затем к внятной ошибке', async () => {
  process.env.TMDB_API_KEY = 'test-key';
  let calls = 0;

  await withMockedFetch(async () => {
    calls += 1;
    return { status: 429, ok: false, headers: new Map([['retry-after', '0']]), text: async () => '', json: async () => ({}) };
  }, async () => {
    await assert.rejects(
      () => tmdbFetch('/movie/popular', {}, { retries: 2 }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'tmdb_rate_limited');
        assert.equal(error.status, 429);
        return true;
      },
    );
  });

  assert.equal(calls, 3, 'должно быть три попытки: исходная + два повтора');
  delete process.env.TMDB_API_KEY;
});

test('X14 · 404 от TMDB — это «нет данных», а не сбой', async () => {
  process.env.TMDB_API_KEY = 'test-key';
  const result = await withMockedFetch(
    async () => ({ status: 404, ok: false, headers: new Map(), text: async () => '', json: async () => ({}) }),
    () => tmdbFetch('/movie/999999999'),
  );
  assert.equal(result, null);
  delete process.env.TMDB_API_KEY;
});

test('X15 · без ключа TMDB прокси сообщает о неверной настройке, а не падает молча', async () => {
  delete process.env.TMDB_API_KEY;
  delete process.env.TMDB_ACCESS_TOKEN;
  await assert.rejects(() => tmdbFetch('/movie/popular'), (error) => {
    assert.equal(error.code, 'tmdb_not_configured');
    assert.equal(error.status, 503);
    return true;
  });
});

test('X16 · компромисс комнаты действительно меняет колоду по сравнению с личной', () => {
  let action = createEmptyProfile();
  for (const t of [LIBRARY.johnWick, LIBRARY.fastFurious, LIBRARY.drive]) action = applySignal(action, t, ACTION.LIKE);

  let drama = createEmptyProfile();
  for (const t of [LIBRARY.notebook, LIBRARY.parasite]) drama = applySignal(drama, t, ACTION.LIKE);

  const seed = () => seededRandom(21);
  const soloDeck = rankDeck(ALL_TITLES, action, { size: 8, explorationRate: 0, random: seed() });
  const roomDeck = rankDeck(ALL_TITLES, buildConsensusProfile([action, drama]), {
    size: 8, explorationRate: 0, random: seed(),
  });

  assert.notDeepEqual(soloDeck.map((c) => c.id), roomDeck.map((c) => c.id),
    'общая колода обязана отличаться от личной');
});

test('X17 · бизнес-события покрывают все точки отказа комнат', () => {
  const roomFailures = [BIZ.ROOM_NOT_FOUND, BIZ.ROOM_EXPIRED, BIZ.ROOM_FULL,
    BIZ.ROOM_CODE_INVALID, BIZ.ROOM_CODE_COLLISION, BIZ.SWIPE_RACE_RETRY];
  assert.equal(new Set(roomFailures).size, roomFailures.length, 'имена событий должны быть уникальны');
  for (const name of roomFailures) assert.match(name, /^[a-z_]+$/, `имя ${name} не в snake_case`);
});

test('X18 · каталог не подмешивает ещё не вышедшие фильмы', async () => {
  process.env.TMDB_API_KEY = 'test-key';
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = `${new Date().getFullYear() + 1}-06-01`;

  const { default: catalogHandler } = await import('../api/tmdb/catalog.js');

  const payload = await withMockedFetch(async (url) => {
    const href = String(url);
    if (href.includes('/configuration')) {
      return jsonResponse({ images: { secure_base_url: 'https://image.tmdb.org/t/p/' } });
    }
    return jsonResponse({
      page: 1,
      total_pages: 1,
      results: [
        { id: 1, title: 'Уже вышел', release_date: '2019-05-30', poster_path: '/a.jpg', vote_average: 8, vote_count: 900 },
        { id: 2, title: 'Только анонс', release_date: nextYear, poster_path: '/b.jpg', vote_average: 9, vote_count: 12 },
        { id: 3, title: 'Дата неизвестна', release_date: null, poster_path: '/c.jpg', vote_average: 7, vote_count: 400 },
      ],
    });
  }, async () => {
    const res = fakeRes();
    await catalogHandler(fakeReq({ url: '/api/tmdb/catalog?list=popular&page=1' }), res);
    return JSON.parse(res.body);
  });

  delete process.env.TMDB_API_KEY;

  assert.equal(payload.ok, true);
  const names = payload.titles.map((t) => t.title);
  assert.deepEqual(names, ['Уже вышел'],
    'в выборе должны остаться только фильмы, которые уже можно посмотреть');
  assert.ok(payload.titles.every((t) => t.releaseDate <= today));
});

/** Ответ, неотличимый от настоящего для нашего клиента TMDB. */
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('X19 · пул каталога дорастает до размера из конфига, а не до лимита страниц', async () => {
  const { CatalogPool } = await import('../src/engine/catalog.js');
  const { RECOMMENDATION_CONFIG } = await import('../shared/config/recommendation.js');

  let pagesServed = 0;

  const pool = await withMockedFetch(async (url) => {
    const page = Number(new URL(String(url), 'http://x').searchParams.get('page') ?? 1);
    pagesServed += 1;
    return jsonResponse({
      ok: true,
      page,
      totalPages: 500,
      // Каждая страница отдаёт свои двадцать фильмов.
      titles: Array.from({ length: 20 }, (_, i) => ({
        id: `tmdb:movie:${page * 100 + i}`,
        title: `Фильм ${page}-${i}`,
        poster: 'https://image.tmdb.org/t/p/w500/x.jpg',
        tags: { action: 60 },
        moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
        quality: 0.7,
      })),
    });
  }, async () => {
    const p = new CatalogPool({ filters: {} });
    await p.fill(RECOMMENDATION_CONFIG.deck.candidatePool);
    return p;
  });

  assert.ok(pool.size >= RECOMMENDATION_CONFIG.deck.candidatePool,
    `пул должен дорасти до ${RECOMMENDATION_CONFIG.deck.candidatePool}, получилось ${pool.size}`);
  assert.ok(pagesServed > 6, `лимит страниц не должен быть жёстким, запрошено ${pagesServed}`);
  assert.equal(pool.exhausted, false, 'при 500 доступных страницах пул не может быть исчерпан');
});

test('X20 · страница из уже решённых фильмов не останавливает ленту', async () => {
  const { CatalogPool } = await import('../src/engine/catalog.js');

  // Первая страница целиком просмотрена, вторая — свежая.
  const seen = Array.from({ length: 20 }, (_, i) => `tmdb:movie:seen-${i}`);
  const history = Object.fromEntries(seen.map((id) => [id, 'watched']));

  const pool = await withMockedFetch(async (url) => {
    const page = Number(new URL(String(url), 'http://x').searchParams.get('page') ?? 1);
    const ids = page === 1 ? seen : Array.from({ length: 20 }, (_, i) => `tmdb:movie:fresh-${page}-${i}`);
    return jsonResponse({
      ok: true,
      page,
      totalPages: 500,
      titles: ids.map((id) => ({
        id,
        title: id,
        poster: 'https://image.tmdb.org/t/p/w500/x.jpg',
        tags: { action: 60 },
        moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
        quality: 0.7,
      })),
    });
  }, async () => {
    const p = new CatalogPool({ filters: {} });
    await p.loadMore();
    return p;
  });

  // После первой страницы показывать нечего — но каталог не исчерпан,
  // и вторая попытка обязана дать карточки.
  const firstPass = rankDeck(pool.all, createEmptyProfile(), { history, size: 40, random: seededRandom(1) });
  assert.equal(firstPass.length, 0, 'все фильмы первой страницы уже решены');
  assert.equal(pool.exhausted, false, 'каталог при этом не исчерпан');

  await withMockedFetch(async (url) => {
    const page = Number(new URL(String(url), 'http://x').searchParams.get('page') ?? 1);
    return jsonResponse({
      ok: true,
      page,
      totalPages: 500,
      titles: Array.from({ length: 20 }, (_, i) => ({
        id: `tmdb:movie:fresh-${page}-${i}`,
        title: `Свежий ${page}-${i}`,
        poster: 'https://image.tmdb.org/t/p/w500/x.jpg',
        tags: { action: 60 },
        moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
        quality: 0.7,
      })),
    });
  }, () => pool.loadMore());

  const secondPass = rankDeck(pool.all, createEmptyProfile(), { history, size: 40, random: seededRandom(1) });
  assert.ok(secondPass.length > 0,
    'следующая страница обязана дать карточки — иначе лента встаёт навсегда');
});

/**
 * Синхронный рост колоды.
 *
 * Каждый свайпает в своём темпе, но порция общая: пока её не прошли все,
 * добавлять карточки нельзя. Иначе быстрый участник уезжает на новую
 * порцию, пока медленный ещё в старой, и общая колода перестаёт быть
 * общей — а «мэтч» превращается в совпадение позиций.
 */
test('X12 · колода комнаты растёт только когда порцию прошли все', () => {
  const deck = Array.from({ length: 25 }, (_, i) => ({ id: `tmdb:movie:${i}` }));

  /** Повторяет расчёт из useRoom: кто сколько карточек колоды отсвайпал. */
  const progressOf = (swipes, members) => {
    const deckIds = new Set(deck.map((t) => t.id));
    const byUser = Object.fromEntries(members.map((uid) => [uid, 0]));
    for (const [titleId, votes] of Object.entries(swipes)) {
      if (!deckIds.has(titleId)) continue;
      for (const uid of Object.keys(votes)) if (uid in byUser) byUser[uid] += 1;
    }
    const values = Object.values(byUser);
    return { size: deck.length, byUser, slowest: values.length ? Math.min(...values) : 0 };
  };

  const swipes = {};
  const members = ['alice', 'bob'];

  // Алиса пролетела всю пачку, Боб — половину.
  deck.forEach((t, i) => {
    swipes[t.id] = { alice: 'like', ...(i < 12 ? { bob: 'pass' } : {}) };
  });

  const mid = progressOf(swipes, members);
  assert.equal(mid.byUser.alice, 25);
  assert.equal(mid.byUser.bob, 12);
  assert.ok(mid.slowest < mid.size, 'пока медленный не закончил, колода расти не должна');

  // Боб догнал — теперь можно.
  deck.forEach((t) => { swipes[t.id].bob = 'pass'; });
  const done = progressOf(swipes, members);
  assert.equal(done.slowest, done.size, 'все прошли порцию — пора добавлять карточки');

  // Голоса за карточки вне колоды не считаются прогрессом по ней.
  swipes['tmdb:movie:999'] = { alice: 'like', bob: 'like' };
  assert.equal(progressOf(swipes, members).slowest, done.size);
});

test('X20 · подборка идёт по краям вкуса, а не по его середине', async () => {
  const { rankDeck } = await import('../src/engine/ranking.js');
  const { createEmptyProfile, applySignal, ACTION } = await import('../src/engine/tasteProfile.js');

  const mk = (id, title, tags, darkness, quality) => ({
    id, title, tags, quality,
    moods: { darkness, energy: 50, intellect: 50, emotion: 50, dynamism: 50 },
  });

  /*
   * Человек любит и мрачное, и лёгкое. Усреднение давало центр между
   * ними — и подборку из фильмов, не похожих ни на один из двух.
   * Это и было «среднее дерьмо»: система награждала посредственность
   * за то, что она посередине.
   */
  const loved = [
    mk('l1', 'Брат', { crime: 100, loner: 90 }, 80, 0.7),
    mk('l2', 'Кин-дза-дза', { comedy: 100, absurdist: 90 }, 40, 0.8),
  ];

  const grim = mk('c1', 'Мрачный', { crime: 95, loner: 85 }, 78, 0.6);
  const light = mk('c2', 'Лёгкий', { comedy: 95, absurdist: 80 }, 42, 0.6);
  // Середина намеренно сделана КАЧЕСТВЕННЕЕ краёв: даже так она
  // не должна выигрывать, иначе замена центроида ничего не дала.
  const middle = mk('c3', 'Серединка', { drama: 60 }, 60, 0.9);

  let profile = createEmptyProfile();
  for (const l of loved) profile = applySignal(profile, l, ACTION.FAVORITE);

  const deck = rankDeck([grim, light, middle], profile, {
    loved, size: 3, explorationRate: 0,
  });

  const byId = Object.fromEntries(deck.map((e) => [e.id, e]));

  assert.ok(byId.c1.score > byId.c3.score * 1.5,
    `край вкуса должен уверенно обгонять середину: ${byId.c1.score} против ${byId.c3.score}`);
  assert.ok(byId.c2.score > byId.c3.score * 1.5);

  // Каждый край тянется к своей опоре, а не к общей точке.
  assert.equal(byId.c1.becauseOf.title, 'Брат');
  assert.equal(byId.c2.becauseOf.title, 'Кин-дза-дза');
});

test('X21 · пул берёт похожих на любимые, а не одну популярку', async () => {
  const { CatalogPool } = await import('../src/engine/catalog.js');
  const { api } = await import('../src/lib/api.js');

  const asked = [];
  const original = api.catalog;

  api.catalog = async (params) => {
    asked.push(params);
    const kind = params.list ?? 'discover';
    return {
      titles: Array.from({ length: 20 }, (_, i) => ({
        id: `tmdb:movie:${kind}-${params.id ?? 0}-${params.page}-${i}`,
        title: `${kind} ${i}`, tags: { drama: 60 }, poster: 'p',
      })),
      page: params.page, totalPages: 50,
    };
  };

  try {
    const pool = new CatalogPool({ filters: {} });
    pool.setSeeds(['tmdb:movie:111', 'tmdb:movie:222']);
    await pool.fill(120);

    const lists = asked.map((p) => p.list);

    /*
     * Пул набирался одной мировой популярностью — признаком, не имеющим
     * к человеку отношения: у всех пользователей выборка была одна и та
     * же, отличался только порядок. Похожие на любимые — это готовый
     * коллаборативный сигнал, и он обязан попадать в пул.
     */
    assert.ok(lists.includes('recommendations'), 'рекомендации TMDB не запрошены');
    assert.ok(lists.includes('similar'), 'похожие не запрошены');
    assert.ok(lists.includes('discover'), 'популярное тоже нужно — иначе пузырь');

    // Идентификатор опоры обязан доезжать: без него TMDB отдаст не то.
    const withId = asked.filter((p) => p.list === 'similar');
    assert.ok(withId.every((p) => Number.isFinite(p.id)), 'у похожих должен быть id фильма');
  } finally {
    api.catalog = original;
  }
});

test('X22 · без любимых пул наполняется так же полно, как и раньше', async () => {
  const { CatalogPool } = await import('../src/engine/catalog.js');
  const { api } = await import('../src/lib/api.js');

  const original = api.catalog;
  api.catalog = async (params) => ({
    titles: Array.from({ length: 20 }, (_, i) => ({
      id: `tmdb:movie:${params.page}-${i}`, title: `Ф${i}`, tags: {}, poster: 'p',
    })),
    page: params.page, totalPages: 50,
  });

  try {
    /*
     * У новичка опор нет. Раньше в этом случае каждая вторая итерация
     * уходила в пустой вызов похожих, и пул недобирал вдвое — то есть
     * холодный старт стал бы хуже, чем был до всей затеи.
     */
    const pool = new CatalogPool({ filters: {} });
    await pool.fill(320);
    assert.ok(pool.size >= 320, `пул должен дорасти до 320, получилось ${pool.size}`);
  } finally {
    api.catalog = original;
  }
});

test('X23 · комната опирается на любимые ОБОИХ, а не одного', async () => {
  const { rankDeck } = await import('../src/engine/ranking.js');
  const { createEmptyProfile, applySignal, ACTION } = await import('../src/engine/tasteProfile.js');
  const { buildConsensusProfile } = await import('../src/engine/ranking.js');

  const mk = (id, title, tags) => ({
    id, title, tags, quality: 0.6,
    moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
  });

  const his = mk('h', 'Брат', { crime: 100, loner: 90 });
  const hers = mk('s', 'Дневник памяти', { romance: 100, tenderness: 90 });

  const forHim = mk('c1', 'Криминальная драма', { crime: 95, loner: 80 });
  const forHer = mk('c2', 'Мелодрама', { romance: 95, tenderness: 80 });
  const forNobody = mk('c3', 'Ни то ни сё', { drama: 50 });

  const consensus = buildConsensusProfile([
    applySignal(createEmptyProfile(), his, ACTION.FAVORITE),
    applySignal(createEmptyProfile(), hers, ACTION.FAVORITE),
  ]);

  /*
   * Раньше в комнату уходили опоры только того, кто нажал «собрать
   * колоду»: собрал он — вечер по его вкусу, собрала она — по её,
   * и никогда по обоим. Половине комнаты подборка была чужой.
   */
  const deck = rankDeck([forHim, forHer, forNobody], consensus, {
    loved: [his, hers], size: 3, explorationRate: 0,
  });
  const byId = Object.fromEntries(deck.map((e) => [e.id, e]));

  assert.ok(byId.c1.score > byId.c3.score, 'фильм под его вкус обязан обгонять ничейный');
  assert.ok(byId.c2.score > byId.c3.score, 'и фильм под её вкус тоже');
  assert.equal(byId.c1.becauseOf.title, 'Брат');
  assert.equal(byId.c2.becauseOf.title, 'Дневник памяти');

  // С опорами одного человека второй остаётся ни с чем — это и чинили.
  const onlyHis = rankDeck([forHim, forHer], consensus, {
    loved: [his], size: 2, explorationRate: 0,
  });
  const hisOnly = Object.fromEntries(onlyHis.map((e) => [e.id, e]));
  assert.ok(hisOnly.c1.score > hisOnly.c2.score,
    'при опорах одного участника подборка кренится в его сторону');
});

test('X24 · комната считает вероятность двойного «да», а не «кому-нибудь зайдёт»', async () => {
  const { affinityAcrossGroups } = await import('../src/engine/affinity.js');

  const mk = (id, title, tags) => ({
    id, title, tags,
    moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
  });

  const his = [mk('h', 'Брат', { crime: 100, loner: 90 })];
  const hers = [mk('s', 'Дневник памяти', { romance: 100, tenderness: 90 })];

  // Идеален ему, чужой ей.
  const onlyHis = mk('a', 'Криминал', { crime: 95, loner: 85 });
  // Обоим средне — но обоим.
  const bothOk = mk('b', 'Криминальная мелодрама', { crime: 55, romance: 55 });

  const one = affinityAcrossGroups(onlyHis, [his, hers]);
  const both = affinityAcrossGroups(bothOk, [his, hers]);

  /*
   * Мэтч — это когда «да» сказали ОБА. Максимумом фильм 0.9/0.1 обходил
   * фильм 0.6/0.6, хотя первый мэтчем не станет никогда, а второй как
   * раз может. Среднее геометрическое расставляет их правильно.
   */
  assert.ok(both.score > one.score,
    `подходящий обоим обязан обгонять идеального одному: ${both.score} против ${one.score}`);

  // Видно, кому фильм подходит хуже всех — по этому читается компромисс.
  assert.equal(one.weakest.title, 'Дневник памяти');
  assert.equal(one.best.title, 'Брат');

  // Участник без опор не должен обнулять всю колоду.
  const withEmpty = affinityAcrossGroups(onlyHis, [his, []]);
  assert.ok(withEmpty.score > 0, 'пустая группа игнорируется, а не обнуляет');

  assert.equal(affinityAcrossGroups(onlyHis, []).score, 0);
});

test('X25 · популярность понижается мягко, а не переворачивает выдачу', async () => {
  const { scoreTitle } = await import('../src/engine/ranking.js');
  const { createEmptyProfile } = await import('../src/engine/tasteProfile.js');

  const mk = (id, popularity, quality = 0.7) => ({
    id, title: id, tags: { drama: 80 }, quality, popularity,
    moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
  });

  const profile = createEmptyProfile();
  const blockbuster = scoreTitle(mk('big', 400), profile).score;
  const obscure = scoreTitle(mk('small', 5), profile).score;

  /*
   * Популярность TMDB самоподдерживающаяся: популярное показывают чаще,
   * от этого оно популярнее. Без поправки лента у всех сходится к одному
   * набору блокбастеров, как бы хорошо ни работал вкус.
   */
  assert.ok(obscure > blockbuster,
    `при равном качестве малоизвестное должно обгонять: ${obscure} против ${blockbuster}`);

  /*
   * Но мягко. Перекрутишь — получишь подборку из безвестного шлака,
   * и это хуже повторов: там хотя бы фильмы хорошие.
   */
  assert.ok(obscure / blockbuster < 1.4, 'поправка не должна переворачивать выдачу');

  // Качество по-прежнему решает: отличный блокбастер обгоняет слабое нишевое.
  const goodBig = scoreTitle(mk('goodBig', 400, 0.95), profile).score;
  const weakSmall = scoreTitle(mk('weakSmall', 5, 0.35), profile).score;
  assert.ok(goodBig > weakSmall, 'хороший популярный обязан обгонять слабый нишевый');
});

test('X26 · разнообразие смотрит на все темы, а не на один ведущий тег', async () => {
  const { rankDeck } = await import('../src/engine/ranking.js');
  const { createEmptyProfile } = await import('../src/engine/tasteProfile.js');

  const mk = (id, tags, quality) => ({
    id, title: id, tags, quality,
    moods: { energy: 50, darkness: 50, intellect: 50, emotion: 50, dynamism: 50 },
  });

  /*
   * Четыре почти одинаковых фильма с РАЗНЫМИ ведущими тегами: прежняя
   * проверка по одному доминирующему тегу их бы не различила и выложила
   * подряд.
   */
  const twins = [
    mk('t1', { samurai: 90, 'sword-fight': 85, japan: 80 }, 0.9),
    mk('t2', { 'sword-fight': 90, samurai: 85, japan: 80 }, 0.88),
    mk('t3', { japan: 90, samurai: 85, 'sword-fight': 80 }, 0.86),
    mk('t4', { samurai: 88, japan: 84, 'sword-fight': 82 }, 0.84),
  ];
  const others = [
    mk('o1', { romcom: 90, romance: 80 }, 0.7),
    mk('o2', { documentary: 90, war: 70 }, 0.7),
  ];

  const deck = rankDeck([...twins, ...others], createEmptyProfile(), {
    size: 6, explorationRate: 0, random: () => 0.5,
  });

  const ids = deck.map((e) => e.id);
  const firstThree = ids.slice(0, 3);
  const twinsUpTop = firstThree.filter((id) => id.startsWith('t')).length;

  assert.ok(twinsUpTop < 3,
    `три почти одинаковых фильма подряд — это провал разнообразия: ${firstThree.join(', ')}`);
});

/* ── Потолок франшизы и план колоды ──────────────────────────── */

test('I13 · одна франшиза не занимает колоду целиком', () => {
  // Разбор живого случая: человек отметил любимыми восемь «Человеков-пауков»,
  // и лента честно принесла ему Marvel целиком — он пролистал влево
  // два десятка супергеройских фильмов подряд.
  const spiders = Array.from({ length: 12 }, (_, i) => makeTitle(
    9000 + i, `Человек-паук ${i + 1}`,
    { genres: [28, 878], keywords: ['superhero', 'spider'], collectionId: 531241, rating: 8.1 },
  ));
  const others = Array.from({ length: 12 }, (_, i) => makeTitle(
    9100 + i, `Другое кино ${i + 1}`,
    { genres: [18], keywords: ['drama', 'family'], rating: 7.6 },
  ));

  // Профиль любит ровно то, чем набита франшиза.
  let profile = createEmptyProfile();
  for (let i = 0; i < 6; i += 1) profile = applySignal(profile, spiders[i], ACTION.FAVORITE);

  const deck = rankDeck([...spiders, ...others], profile, {
    size: 10, explorationRate: 0, random: seededRandom(7),
  });

  const fromFranchise = deck.filter((e) => e.title.collectionId === 531241).length;
  assert.ok(fromFranchise <= RECOMMENDATION_CONFIG.penalties.maxPerFranchise,
    `из одной франшизы взято ${fromFranchise} карточек при потолке ${RECOMMENDATION_CONFIG.penalties.maxPerFranchise}`);
  assert.ok(deck.length === 10, 'потолок не должен обрывать колоду — остальное добирается другим');
});

test('I14 · колода собирается по плану: близкое, проверка вкуса, противоположности', () => {
  // Прогретый профиль: план вступает в силу только когда есть от чего
  // отталкиваться — новичку противопоставлять нечего.
  let profile = createEmptyProfile();
  for (let round = 0; round < 16; round += 1) {
    profile = applySignal(profile, LIBRARY.johnWick, ACTION.LIKE);
    profile = applySignal(profile, LIBRARY.drive, ACTION.LIKE);
  }

  const deck = rankDeck(ALL_TITLES, profile, { size: 12, random: seededRandom(11) });
  const slots = deck.reduce((acc, e) => ({ ...acc, [e.slot]: (acc[e.slot] ?? 0) + 1 }), {});

  assert.ok((slots.far ?? 0) > 0, 'в колоде должны быть намеренно далёкие карточки');
  assert.ok((slots.explore ?? 0) > 0, 'и карточки на проверку вкуса');
  assert.ok((slots.profile ?? 0) > (slots.far ?? 0), 'но похожего на любимое — больше всего');
});

test('I15 · семена берутся по одному на франшизу', async () => {
  const { spreadSeeds } = await import('../src/hooks/useDeck.js');
  const { FRANCHISE_WEIGHT } = await import('../shared/taxonomy/franchises.js');

  const loved = [
    { id: 'a', tags: { 'spider-man': FRANCHISE_WEIGHT, marvel: 40 } },
    { id: 'b', tags: { 'spider-man': FRANCHISE_WEIGHT, marvel: 40 } },
    { id: 'c', tags: { 'spider-man': FRANCHISE_WEIGHT, marvel: 40 } },
    { id: 'd', tags: { samurai: 80, drama: 60 } },
    { id: 'e', tags: { romcom: 70 } },
  ];

  const seeds = spreadSeeds(loved, 3).map((a) => a.id);
  assert.deepEqual(seeds, ['a', 'd', 'e'],
    'вторая и третья части одной франшизы уступают место другим вкусам');

  // Если разнообразия не хватило — добираем пропущенным, а не оставляем пусто.
  assert.equal(spreadSeeds(loved.slice(0, 3), 3).length, 3);
});

/* ── Переходы в Telegram: чат, канал, обменник, «поделиться» ───── */

/**
 * Здесь проверяется одно утверждение, на котором держатся все переходы
 * наружу: с Bot API 7.0 `openTelegramLink` НЕ закрывает Mini App.
 *
 * Раньше код считал наоборот, и из-за этого «где купить звёзды» вело
 * не в обменник, а в уведомление о том, что бот прислал ссылку, а
 * «пригласить» — в буфер обмена. Если однажды кто-то снова решит, что
 * ссылка закрывает приложение, падать должно здесь, а не в отзывах.
 */
const withTelegram = async (webApp, fn) => {
  const original = globalThis.Telegram;
  globalThis.Telegram = webApp ? { WebApp: webApp } : undefined;
  try { return await fn(); } finally { globalThis.Telegram = original; }
};

const fakeWebApp = (version) => {
  const opened = [];
  return {
    opened,
    version,
    platform: 'ios',
    initData: 'user=%7B%22id%22%3A1%7D',
    openTelegramLink(url) { opened.push(url); },
    openLink(url) { opened.push(`external:${url}`); },
  };
};

test('T1 · на клиенте 7.0+ ссылка в Telegram не закрывает Mini App', async () => {
  const app = fakeWebApp('7.10');
  await withTelegram(app, async () => {
    const tg = await import('../src/lib/telegram.js');
    assert.equal(tg.keepsAppOpenOnTelegramLink(), true);
    assert.equal(tg.openTelegramLink('https://t.me/GeekStarsBot?start=x'), 'kept');
    assert.deepEqual(app.opened, ['https://t.me/GeekStarsBot?start=x']);
  });
});

test('T2 · на клиенте старше 7.0 переход честно называется закрывающим', async () => {
  const app = fakeWebApp('6.9');
  await withTelegram(app, async () => {
    const tg = await import('../src/lib/telegram.js');
    assert.equal(tg.keepsAppOpenOnTelegramLink(), false);
    assert.equal(tg.openTelegramLink('https://t.me/somebot'), 'closed');
  });
});

test('T3 · вне Telegram переход уходит наружу, а не притворяется удачным', async () => {
  await withTelegram(null, async () => {
    const tg = await import('../src/lib/telegram.js');
    assert.equal(tg.keepsAppOpenOnTelegramLink(), false);
    assert.equal(tg.shareViaTelegramPicker({ url: 'https://t.me/x' }), false);
  });
});

test('T4 · «поделиться» открывает родное окно выбора чата с пробелами, а не с плюсами', async () => {
  const app = fakeWebApp('7.10');
  await withTelegram(app, async () => {
    const tg = await import('../src/lib/telegram.js');
    const result = tg.shareViaTelegramPicker({
      url: 'https://t.me/bot/app?startapp=12345',
      text: 'Заходите в комнату 12345',
    });

    assert.equal(result, 'kept');
    const [url] = app.opened;
    assert.ok(url.startsWith('https://t.me/share/url?'), url);
    assert.ok(url.includes('url=https%3A%2F%2Ft.me%2Fbot%2Fapp%3Fstartapp%3D12345'), url);
    /* Плюс вместо пробела приезжает получателю как плюс — этого быть не должно. */
    assert.ok(!url.includes('+'), url);
    assert.equal(
      decodeURIComponent(new URL(url).searchParams.get('text')),
      'Заходите в комнату 12345',
    );
  });
});

test('T5 · официальные аккаунты: пункт есть только у настроенного адреса', async () => {
  const { officialAccounts, telegramUrl } = await import('../shared/config/contacts.js');

  const empty = officialAccounts({});
  assert.deepEqual(empty, [], 'без бота и без обменника список пуст, а не с пустыми строками');

  const list = officialAccounts({
    bot: '@MatchWatchBot',
    starsShop: { url: 'https://t.me/GeekStarsBot?start=u', note: 'Партнёрская' },
    config: {
      channel: { username: 'https://t.me/matchwatch_news', title: 'Канал', note: 'Что нового' },
      chat: null,
      support: null,
    },
  });

  assert.deepEqual(list.map((a) => a.key), ['bot', 'channel', 'stars_shop']);
  /* Собачка и полный адрес в настройках — нормальная запись, а не поломка ссылки. */
  assert.equal(list[0].url, 'https://t.me/MatchWatchBot?start=hub');
  assert.equal(list[1].url, 'https://t.me/matchwatch_news');
  assert.equal(telegramUrl('@x'), 'https://t.me/x');
  assert.equal(telegramUrl('   '), null);
});
