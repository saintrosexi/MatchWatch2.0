/**
 * Оркестратор свайп-ленты.
 *
 * Важная деталь поведения: колода НЕ пересобирается на каждый свайп.
 * Профиль вкуса обновляется мгновенно, но уже показанная очередь остаётся
 * стабильной — иначе карточки прыгали бы под пальцем. Новый порядок
 * применяется к следующей порции, когда очередь подходит к концу.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CatalogPool, loadActorDeck } from '../engine/catalog.js';
import { rankDeck, isDecided } from '../engine/ranking.js';
import { roomQueueEntries } from '../engine/roomDeck.js';
import { createSessionMood, resortQueue } from '../engine/sessionMood.js';
import { getConfig } from '../engine/recommendationConfig.js';
import { api, describeError } from '../lib/api.js';
import { trackBusiness } from '../lib/telemetry.js';
import { BIZ, MODULE } from '../../shared/telemetry/events.js';
import { parseTitleId } from '../../shared/model/title.js';
import { franchiseOf, universeOf } from '../../shared/taxonomy/franchises.js';

export const DECK_MODE = Object.freeze({ SOLO: 'solo', ACTOR: 'actor', ROOM: 'room' });

/**
 * Сколько кругов дозагрузки допустимо, если каждая порция оказывается
 * целиком просмотренной. Двенадцать страниц за круг — это до трёх тысяч
 * фильмов, дальше честнее сказать, что под фильтры ничего не осталось.
 */
/**
 * Сколько страниц каталога перелистываем за один заход дозагрузки.
 *
 * Числа кругов не ограничиваем вовсе: единственный честный признак конца —
 * исчерпанный каталог, и его сообщает сам пул. Лимит на круги стоял
 * раньше и упирался в стенку там, где человек просто много насмотрел:
 * у пятисот решений первые двадцать страниц популярного выедены почти
 * целиком, и лента замирала на горстке карточек с надписью «колода
 * закончилась», хотя впереди оставалось ещё четыреста восемьдесят страниц.
 */
const REFILL_PAGES_PER_ROUND = 20;

/**
 * Пауза перед повторным кругом дозагрузки, когда предыдущий ничего
 * не принёс. Человек её не замечает, а процессор за это время успевает
 * отдать кадр браузеру — и фоновая доливка пула успевает продвинуться.
 */
const REFILL_RETRY_PAUSE = 500;

/**
 * Снимает карточку с очереди.
 *
 * Убирать «первую попавшуюся» нельзя: к моменту вызова карточку мог уже
 * забрать фильтр решённых, и тогда слепой сдвиг съел бы следующую —
 * пользователь видит, как под верхней карточкой подменяется фильм.
 * Поэтому удаляем строго по идентификатору, а без него — первую.
 */
/**
 * Отбирает опоры для семян так, чтобы одна франшиза не заняла все.
 *
 * Порядок сохраняется — свежие любимые впереди, — но вторая и далее
 * части одной франшизы пропускаются, пока есть что-то ещё. Если
 * разнообразия не хватило, добираем пропущенным: лучше десять семян
 * из одной вселенной, чем два семени и пустая колода.
 */
export function spreadSeeds(loved, limit = 10) {
  const list = loved ?? [];
  const picked = [];
  const skipped = [];
  const franchises = new Set();
  const universes = new Map();

  for (const anchor of list) {
    if (picked.length >= limit) break;
    const franchise = franchiseOf(anchor.tags);
    const universe = universeOf(anchor.tags);

    const franchiseTaken = franchise && franchises.has(franchise);
    const universeFull = universe && (universes.get(universe) ?? 0) >= 2;

    if (franchiseTaken || universeFull) { skipped.push(anchor); continue; }

    if (franchise) franchises.add(franchise);
    if (universe) universes.set(universe, (universes.get(universe) ?? 0) + 1);
    picked.push(anchor);
  }

  for (const anchor of skipped) {
    if (picked.length >= limit) break;
    picked.push(anchor);
  }
  return picked;
}

export function advanceQueue(queue, id) {
  if (!queue.length) return queue;
  if (!id) return queue.slice(1);

  const index = queue.findIndex((entry) => entry.id === id);
  if (index === -1) return queue; // уже убрана — очередь не трогаем
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

/**
 * Убирает из очереди карточки, решение по которым появилось уже после
 * сборки — например, история догрузилась позже.
 *
 * Верхнюю карточку не трогаем: она уходит только своей анимацией свайпа.
 * Иначе решение по ней мгновенно подменяло бы картинку на следующую ещё
 * до того, как карточка улетит.
 *
 * В комнате не срезает ничего. Общая колода одна на всех, а личная
 * история у каждого своя: вычитая её здесь, мы резали общий набор
 * по-разному у каждого участника — из двадцати пяти карточек у одного
 * оставалась одна, у другого три, и оба видели «колода закончилась»,
 * хотя колода была цела.
 */
export function pruneDecided(queue, history, mode) {
  if (mode === DECK_MODE.ROOM) return queue;
  if (!queue || queue.length < 2) return queue;

  const [top, ...rest] = queue;
  const filtered = rest.filter((entry) => !isDecided(history?.[entry.id]));
  return filtered.length === rest.length ? queue : [top, ...filtered];
}

export function useDeck({
  mode = DECK_MODE.SOLO,
  filters = {},
  taste,
  history = {},
  /**
   * Опоры вкуса: конкретные любимые и отвергнутые фильмы.
   *
   * Заменяют усреднённый профиль как главный сигнал. Без них движок
   * работает по накопленному вектору, как раньше, — то есть новичок
   * ничего не теряет, просто не получает лучшего.
   */
  anchors = null,
  /**
   * Режим подачи: 'calm' — спокойный вечер, 'discovery' — поиск нового.
   *
   * Живёт в сессии и в постоянный профиль не пишется: это выбор
   * настроения на вечер, а не заявление о себе.
   */
  feedMode = 'calm',
  actorId = null,
  roomDeck = null,
  /**
   * Мои голоса в этой комнате. Отдельно от личной истории намеренно:
   * общая колода одна на всех, и отсеивать из неё можно только то,
   * на что этот человек уже ответил, — иначе наборы разъезжаются.
   */
  roomSwiped = null,
  /**
   * Любимые остальных участников: [{ name, loved }].
   *
   * Нужны не для порядка — он общий и приходит готовым, — а для второй
   * строки подписи: «и на "Титаник" — любимый Сони». Вечер вдвоём
   * разваливается не на вопросе «нравится ли мне», а на вопросе
   * «а ей зайдёт?», и ответ на него у нас есть.
   */
  roomPartners = null,
  enabled = true,
}) {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  /** Дозагрузка следующей пачки: очередь пуста, но кино ещё есть. */
  const [refilling, setRefilling] = useState(false);
  const [error, setError] = useState(null);
  const [exhausted, setExhausted] = useState(false);
  const [processed, setProcessed] = useState(0);
  /** Счётчик кругов дозагрузки: растёт, когда очередная порция вся решена. */
  const [refillNonce, setRefillNonce] = useState(0);
  /*
   * Пулы каталога по набору фильтров.
   *
   * Смена фильтров создавала пул заново, с первой страницы. Вернувшись
   * к прежнему набору, человек снова упирался в те же уже просмотренные
   * страницы — и лента «кончалась» через несколько карточек. Сохранённый
   * пул продолжает с того места, где остановился.
   */
  const poolsRef = useRef(new Map());

  const poolRef = useRef(null);
  const refillingRef = useRef(false);
  /** Момент, до которого дозагрузка не повторяется после сетевой неудачи. */
  const refillBlockedUntil = useRef(0);
  /** Таймер отложенного круга дозагрузки — чтобы его можно было снять. */
  const retryTimer = useRef(null);
  const queuedIds = useRef(new Set());
  /*
   * Настроение вечера. Живёт в ссылке, а не в состоянии: меняется
   * на каждый свайп, а перерисовывать из-за него нечего — оно влияет
   * только на порядок хвоста очереди.
   */
  const sessionRef = useRef(createSessionMood());
  const tasteRef = useRef(taste);
  const anchorsRef = useRef(anchors);
  const historyRef = useRef(history);
  const partnersRef = useRef(roomPartners);
  const generation = useRef(0);

  tasteRef.current = taste;
  anchorsRef.current = anchors;
  historyRef.current = history;
  partnersRef.current = roomPartners;

  const filterKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  /*
   * Пул кандидатов — свой на каждый режим подачи.
   *
   * Ключа из одних фильтров было мало, и это ломало ровно то, ради чего
   * режимы делались. Горячие семена режима поиска тянут в пул похожее
   * на сиюминутный лайк; пул был общий, и, вернувшись в спокойную ленту,
   * человек получал её же — пять серий подряд того, о чём он в «Моё»
   * не просил. Спокойная лента обязана быть тем, что накоплено вообще,
   * а не тем, что зацепило десять минут назад в другом режиме.
   *
   * Плата за развязку — первый вход в каждый режим наполняет свой пул.
   * Дальше оба живут в памяти, и переключение снова мгновенно.
   */
  const poolKey = useMemo(() => `${feedMode}|${filterKey}`, [feedMode, filterKey]);
  const roomDeckKey = useMemo(
    () => (roomDeck ?? []).map((t) => t.id ?? t.titleId).join('|'),
    [roomDeck],
  );

  /** Добирает карточки в очередь из пула, не трогая уже показанные. */
  const extend = useCallback((pool, { size } = {}) => {
    const config = getConfig();
    const candidates = pool.all.filter((t) => !queuedIds.current.has(t.id));
    if (!candidates.length) return 0;

    const ranked = rankDeck(candidates, tasteRef.current, {
      loved: anchorsRef.current?.loved,
      refused: anchorsRef.current?.refused,
      config,
      history: historyRef.current,
      size: size ?? config.deck.soloSize,
      explorationRate: mode === DECK_MODE.ACTOR ? 0 : undefined,
      feedMode,
      // Сегодняшние лайки как опоры: за ними идёт лента в режиме поиска.
      sessionLoved: sessionRef.current.likedTitles(),
    });

    if (!ranked.length) return 0;
    ranked.forEach((entry) => queuedIds.current.add(entry.id));
    setQueue((prev) => [...prev, ...ranked]);

    // Обогащаем теги ближайших карточек — переранжирование следующей
    // порции будет уже по настоящим keywords, а не по жанрам.
    pool.enrich(ranked.slice(0, 16).map((e) => e.id));
    return ranked.length;
  }, [mode, feedMode]);

  /**
   * Вставляет свежих кандидатов сразу за верхними карточками.
   *
   * Нужно режиму поиска и только ему. Обычная дозагрузка дописывает
   * карточки в хвост, и приехавшее по горячему семени человек увидел бы
   * через полтора десятка свайпов — то есть уже не как ответ на свой
   * лайк, а как случайность. Здесь же лента поворачивает в ближайшие
   * несколько карточек, ровно как он и просил.
   *
   * Две верхние не трогаются: одна под пальцем, вторая видна за ней,
   * и подмена любой из них читается как сбой, а не как забота.
   */
  const injectFresh = useCallback((pool, count) => {
    const config = getConfig();
    const candidates = pool.all.filter((t) => !queuedIds.current.has(t.id));
    if (!candidates.length) return 0;

    const ranked = rankDeck(candidates, tasteRef.current, {
      loved: anchorsRef.current?.loved,
      refused: anchorsRef.current?.refused,
      config,
      history: historyRef.current,
      size: count,
      feedMode,
      sessionLoved: sessionRef.current.likedTitles(),
    });
    if (!ranked.length) return 0;

    ranked.forEach((entry) => queuedIds.current.add(entry.id));
    setQueue((prev) => [...prev.slice(0, 2), ...ranked, ...prev.slice(2)]);
    pool.enrich(ranked.map((e) => e.id));
    return ranked.length;
  }, [feedMode]);

  /**
   * Страховка: если решение по тайтлу появилось уже после того, как он
   * попал в очередь (например, история догрузилась позже сборки), карточка
   * обязана исчезнуть из очереди, а не всплыть повторно.
   *
   * В комнате эта страховка вредна и потому выключена. Общая колода одна
   * на всех, а личная история у каждого своя: вычитая её здесь, мы резали
   * общий набор по-разному у каждого участника. Из двадцати пяти карточек
   * у одного оставалась одна, у другого три — и оба видели «колода
   * закончилась», хотя колода была цела. Всё, что комната обязана
   * пропустить, отсекается один раз при генерации и сразу по всем
   * участникам; свои голоса в этой комнате убирает `roomSwiped`.
   */
  useEffect(() => {
    setQueue((prev) => pruneDecided(prev, history, mode));
  }, [history, mode]);

  /**
   * Тянет страницы каталога, пока не наберёт НОВЫХ карточек.
   *
   * Одной попытки мало: при большой истории решений подряд идущие
   * страницы могут целиком состоять из уже просмотренного. Особенно
   * при сортировке «новинки» — пользователь проходит каталог сверху,
   * и первые страницы выедаются полностью.
   */
  const pullNewCards = useCallback(async (pool, { size, maxPages = 12, signal } = {}) => {
    let added = extend(pool, { size });
    let pages = 0;

    while (added === 0 && pages < maxPages && !pool.exhausted) {
      pages += 1;
      const before = pool.size;
      await pool.loadMore({ signal });
      if (pool.size === before) break;
      added = extend(pool, { size });
    }

    return { added, poolExhausted: pool.exhausted, pages };
  }, [extend]);

  /* Сборка колоды при смене режима/фильтров. */
  useEffect(() => {
    if (!enabled) return undefined;

    const myGeneration = ++generation.current;
    const controller = new AbortController();

    queuedIds.current = new Set();
    sessionRef.current.reset();
    refillBlockedUntil.current = 0;
    // Отложенный круг принадлежал прежним фильтрам — он больше не нужен.
    clearTimeout(retryTimer.current);
    setQueue([]);
    setProcessed(0);
    setRefillNonce(0);
    setExhausted(false);
    setError(null);
    setLoading(true);

    (async () => {
      try {
        if (mode === DECK_MODE.ROOM) {
          const stubs = roomDeck ?? [];
          if (!stubs.length) { setLoading(false); return; }

          // Комната хранит только компактные карточки — полные данные
          // (теги, описание, актёры) добираем через кэширующий прокси.
          const ids = stubs
            .map((s) => Number(parseTitleId(s.id ?? s.titleId)?.externalId))
            .filter(Number.isFinite);

          const chunks = [];
          for (let i = 0; i < ids.length; i += 24) chunks.push(ids.slice(i, i + 24));
          const responses = await Promise.all(
            chunks.map((chunk) => api.enrich(chunk, { signal: controller.signal }).catch(() => ({ titles: [] }))),
          );
          if (generation.current !== myGeneration) return;

          const byId = new Map(responses.flatMap((r) => r.titles ?? []).map((t) => [t.id, t]));

          /*
           * Порядок берётся из колоды комнаты как есть и ничем больше
           * не фильтруется. Раньше здесь отсеивалось личное «просмотрено»,
           * и у двоих получались разные наборы — со стороны это выглядело
           * как случайные карточки вместо общей колоды. Всё, что нужно
           * исключить, отсекается один раз при генерации, сразу по всем
           * участникам; свои уже отданные голоса убирает `extend`.
           */
          const voted = new Set(roomSwiped ?? []);
          const ordered = stubs
            .map((stub) => byId.get(stub.id ?? stub.titleId) ?? hydrateStub(stub))
            .filter(Boolean)
            .filter((t) => !voted.has(t.id));

          ordered.forEach((t) => queuedIds.current.add(t.id));

          /*
           * Порядок общий, объяснение — личное.
           *
           * Здесь стояли пустые заглушки: оценка ноль, ни одного совпавшего
           * тега, уверенность всегда «слабая». Колода при этом собиралась
           * по вкусам всех участников — но вся эта работа оставалась
           * на устройстве того, кто нажал «собрать», а на экран доезжал
           * один только порядок. Под каждой карточкой человек видел
           * запасной текст про оценку и «оцениваем ваш вкус», то есть
           * ровно то, что показывают, когда сказать нечего.
           *
           * Пересчитывать порядок нельзя: колода обязана быть одинаковой
           * у всех, иначе это уже не общий выбор. А «почему» у каждого
           * своё — «похоже на "Брата", который вам зашёл» говорится тому,
           * кто смотрит, а не среднему по комнате.
           */
          setQueue(roomQueueEntries(ordered, tasteRef.current, {
            anchors: anchorsRef.current,
            partners: partnersRef.current,
            config: getConfig(),
            history: historyRef.current,
          }));
          setLoading(false);
          return;
        }

        if (mode === DECK_MODE.ACTOR) {
          const { titles } = await loadActorDeck(actorId, { signal: controller.signal });
          if (generation.current !== myGeneration) return;
          const ranked = rankDeck(titles, tasteRef.current, {
            loved: anchorsRef.current?.loved,
            refused: anchorsRef.current?.refused,
            config: getConfig(), history: historyRef.current, size: titles.length, explorationRate: 0,
          });
          ranked.forEach((e) => queuedIds.current.add(e.id));
          setQueue(ranked);
          setExhausted(true);
          setLoading(false);
          if (!ranked.length) {
            trackBusiness(BIZ.DECK_EMPTY_AFTER_FILTERS, {
              module: MODULE.DECK, context: { mode, actorId },
            });
          }
          return;
        }

        const pool = poolsRef.current.get(poolKey) ?? new CatalogPool({ filters });
        poolsRef.current.set(poolKey, pool);

        /*
         * Семена отбора: самые свежие из любимых, но по одному
         * на франшизу.
         *
         * Раньше брались первые десять подряд. У человека, отметившего
         * любимыми восемь «Человеков-пауков», все десять семян уходили
         * в одну франшизу — а каждое семя тянет из каталога «похожее
         * на себя». Отсюда и лента, целиком состоящая из Marvel:
         * дело было не в оценке карточек, а в том, что других
         * кандидатов в неё просто не приезжало.
         *
         * Больше десятка не берём — каждое стоит двух запросов
         * к каталогу, а разнообразие после десяти уже не растёт.
         */
        pool.setSeeds(spreadSeeds(anchorsRef.current?.loved, 10).map((a) => a.id));
        poolRef.current = pool;

        /*
         * Первая стадия: ровно столько, сколько нужно для первой колоды.
         * Стартовый набор грузится параллельно — он приезжает одним
         * запросом и первую карточку не задерживает.
         */
        await Promise.all([
          pool.fill(getConfig().deck.firstFill, { signal: controller.signal }),
          pool.primeColdStart({ signal: controller.signal }),
        ]);
        if (generation.current !== myGeneration) return;

        const { added, poolExhausted, pages } = await pullNewCards(pool, {
          size: getConfig().deck.soloSize,
          signal: controller.signal,
        });
        if (generation.current !== myGeneration) return;
        setLoading(false);

        /*
         * Вторая стадия — фоном. Ранжирование следующих порций станет
         * точнее на широком пуле, но первая карточка этого не ждёт:
         * полный набор это полтора десятка последовательных запросов.
         */
        pool.fill(pool.size + getConfig().deck.candidatePool, { signal: controller.signal })
          .catch(() => { /* не критично: очередь уже наполнена */ });

        if (!added) {
          // Пусто по-настоящему только если каталог кончился. Иначе это
          // просто длинная полоса уже решённого — пробуем листать дальше.
          if (poolExhausted) {
            setExhausted(true);
            trackBusiness(BIZ.DECK_EMPTY_AFTER_FILTERS, {
              module: MODULE.DECK, context: { mode, pages, ...filters },
            });
          } else {
            setRefillNonce((n) => n + 1);
          }
        }
      } catch (e) {
        if (generation.current !== myGeneration) return;
        setError(describeError(e));
        setLoading(false);
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    /*
     * `roomSwiped` намеренно вне зависимостей: он меняется на каждый свой
     * свайп, и колода пересобиралась бы под руками. Учитывается он только
     * при сборке — то есть при входе в комнату и при росте колоды.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    /*
     * `feedMode` в зависимостях обязателен: человек переключает режим,
     * чтобы лента изменилась СЕЙЧАС. Без пересборки новый состав пришёл бы
     * только со следующей порцией — то есть карточек через двадцать,
     * и переключатель выглядел бы неработающим.
     */
  }, [mode, poolKey, actorId, roomDeckKey, enabled, feedMode]);

  /**
   * Дозагрузка следующей пачки.
   *
   * Тянем страницы каталога до тех пор, пока не наберём НОВЫХ карточек,
   * а не пока просто не вырастет пул. Очередная страница целиком может
   * состоять из уже решённых фильмов — тогда прирост пула есть, а
   * показывать нечего, и один заход ничего не решает.
   */
  /**
   * Просит следующий круг дозагрузки — через паузу, а не сразу.
   *
   * Пауза нужна ровно затем, чтобы круги шли через цикл событий:
   * без неё пустые заходы складываются в синхронную петлю.
   */
  const scheduleRetry = useCallback(() => {
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => setRefillNonce((n) => n + 1), REFILL_RETRY_PAUSE);
  }, []);

  const refill = useCallback(async () => {
    if (refillingRef.current) return;
    if (Date.now() < refillBlockedUntil.current) return;
    const pool = poolRef.current;
    if (!pool) return;

    if (pool.exhausted) {
      setExhausted(true);
      return;
    }

    refillingRef.current = true;
    setRefilling(true);

    try {
      const { added, poolExhausted, pages } = await pullNewCards(pool, {
        // Та же порция, что и у первой колоды: лента идёт ровными
        // двадцатью пятью, а не «шестьдесят сначала, сорок потом».
        size: getConfig().deck.soloSize, maxPages: REFILL_PAGES_PER_ROUND,
      });

      // Нашли хоть что-то — полоса решённого кончилась, счёт заново.
      if (added) setRefillNonce(0);

      if (!added) {
        if (poolExhausted) {
          setExhausted(true);
          trackBusiness(BIZ.DECK_EXHAUSTED, {
            module: MODULE.DECK, context: { seen: processed, poolSize: pool.size, pages },
          });
        } else {
          /*
           * Полоса решённого оказалась длиннее одного захода — просим
           * ещё круг. Но не в том же кадре.
           *
           * Пустой заход не всегда значит «в каталоге ничего нет».
           * Пул отвечает нулём и когда он просто занят: пока идёт
           * фоновая доливка кандидатов, loadMore возвращает ноль
           * немедленно, ничего не загружая. Круг при этом получался
           * мгновенным, следующий начинался в той же микрозадаче,
           * и лента крутила их тысячами в секунду, пока доливка
           * не закончится: React ругался на переполнение глубины
           * обновлений, а телефон грелся на ровном месте.
           *
           * Пауза разрывает эту петлю. Кругов по-прежнему сколько
           * угодно — единственный честный признак конца это исчерпанный
           * каталог, — просто между ними browser успевает дышать,
           * а фоновая доливка успевает что-то принести.
           */
          scheduleRetry();
        }
      }
    } catch (e) {
      /*
       * Сеть отвалилась. Пауза перед следующей попыткой обязательна:
       * без неё эффект будет дёргать каталог на каждом рендере, пока
       * связь не вернётся, — на мобильном интернете это десятки
       * запросов в секунду.
       */
      refillBlockedUntil.current = Date.now() + 4000;
      if (queuedIds.current.size === 0) setError(describeError(e));
    } finally {
      refillingRef.current = false;
      setRefilling(false);
    }
  }, [pullNewCards, processed, scheduleRetry]);

  /* Запускаем дозагрузку, когда очередь подходит к концу. */
  useEffect(() => {
    if (mode !== DECK_MODE.SOLO || loading || exhausted) return;
    if (!poolRef.current) return;
    if (queue.length > getConfig().deck.prefetchThreshold) return;

    refill();
  }, [queue.length, loading, exhausted, mode, refill, refillNonce]);

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  const advance = useCallback((id, liked = null) => {
    /*
     * Горячее семя: лайк в режиме поиска сразу заказывает похожее
     * из каталога.
     *
     * Пересортировки хвоста для этого мало — она меняет порядок уже
     * загруженного, а человек, лайкнувший незнакомый фильм, ждёт, что
     * лента принесёт ЕЩЁ такого же, чего в пуле пока просто нет.
     *
     * Только в режиме поиска и намеренно. В спокойной ленте состав
     * обязан быть предсказуемым: она обновляется ровными порциями
     * по двадцать пять, и подмешивать в неё выдачу по одному свайпу
     * значило бы сделать «просто полистать своё» такой же дёрганой,
     * как и поиск.
     */
    if (liked === true && feedMode === 'discovery' && mode === DECK_MODE.SOLO) {
      const pool = poolRef.current;
      if (pool?.pushSeed(id)) {
        // Похожие — добавка, а не условие работы: молча живём без них.
        pool.loadSimilar()
          .then((added) => { if (added) injectFresh(pool, 6); })
          .catch(() => {});
      }
    }

    setQueue((prev) => {
      /*
       * Решение кормит настроение вечера, и хвост очереди
       * пересортировывается под него: отклонил пять мрачных подряд —
       * дальше мрачного будет меньше. Верхние карточки не трогаются:
       * подмена картинки под рукой читается как сбой, а не как забота.
       */
      const decided = prev.find((entry) => entry.id === id);
      if (decided && liked !== null) sessionRef.current.record(decided.title, liked);

      /*
       * В комнате хвост не трогается. Колода там общая, и порядок —
       * часть этой общности: пересортировав её под себя, я начну листать
       * не то же самое, что листает она, и «мы выбираем вместе»
       * перестанет быть правдой. Настроение вечера при этом копится
       * как обычно — оно пригодится в личной ленте.
       */
      const next = advanceQueue(prev, id);
      if (mode === DECK_MODE.ROOM) return next;
      const config = getConfig();
      return resortQueue(next, sessionRef.current, {
        config,
        boost: config.feed?.[feedMode]?.sessionBoost ?? 1,
      });
    });
    setProcessed((n) => n + 1);
  }, [mode, feedMode, injectFresh]);

  /**
   * Возвращает карточку в начало очереди.
   *
   * Используется отменой решения: сама запись в истории и профиль вкуса
   * откатываются отдельно, здесь — только видимая часть.
   */
  const restore = useCallback((entry) => {
    if (!entry) return;
    queuedIds.current.add(entry.id);
    setQueue((prev) => (prev.some((e) => e.id === entry.id) ? prev : [entry, ...prev]));
    setProcessed((n) => Math.max(0, n - 1));
  }, []);

  const skipTo = useCallback((titleId) => {
    setQueue((prev) => {
      const index = prev.findIndex((e) => e.id === titleId);
      return index > 0 ? prev.slice(index) : prev;
    });
  }, []);

  const retry = useCallback(() => {
    generation.current += 1;
    setError(null);
    setLoading(true);
    setQueue([]);
    queuedIds.current = new Set();
    // Повтор после сбоя начинает с чистого пула: прежний мог остаться
    // на середине неудачной страницы.
    poolsRef.current.delete(poolKey);
    poolRef.current = null;
    setProcessed((n) => n);
    const pool = new CatalogPool({ filters });
    poolsRef.current.set(poolKey, pool);
    poolRef.current = pool;
    pool.fill(getConfig().deck.candidatePool)
      .then(() => { extend(pool); setLoading(false); })
      .catch((e) => { setError(describeError(e)); setLoading(false); });
  }, [filters, poolKey, extend]);

  const total = processed + queue.length;

  return {
    queue,
    current: queue[0] ?? null,
    /*
     * Две карточки под верхней, а не три. Третья стояла с opacity 0 —
     * невидимая, но со своим слоем композитинга и своим постером
     * в полном разрешении. На телефоне это лишний экран отрисовки
     * на каждом кадре свайпа.
     */
    upcoming: queue.slice(1, 3),
    loading,
    /** Очередь пуста, но следующая пачка уже едет — это не конец колоды. */
    refilling,
    error,
    exhausted: exhausted && queue.length === 0 && !refilling,
    processed,
    progress: total ? processed / total : 0,
    advance,
    restore,
    skipTo,
    retry,
    /*
     * Весь загруженный каталог, а не очередь.
     *
     * Нужен рулетке. Она брала `queue` — те самые карточки, что лежат
     * перед человеком, — и потому показывала ему то, что и так на экране.
     * Здесь сотни фильмов против двух десятков.
     *
     * Функция, а не значение: пул живёт в ref и меняется по мере
     * подгрузки, так что читать его надо в момент открытия рулетки,
     * а не на каждом рендере колоды.
     */
    catalog: () => poolRef.current?.all ?? [],
  };
}

/** Мягкая деградация: если обогатить не удалось, карточку всё равно покажем. */
function hydrateStub(stub) {
  if (!stub?.id && !stub?.titleId) return null;
  return {
    id: stub.id ?? stub.titleId,
    title: stub.title ?? 'Без названия',
    year: stub.year ?? null,
    poster: stub.poster ?? null,
    rating: stub.rating ?? null,
    tags: {},
    moods: null,
    quality: 0.5,
    genres: [],
    partial: true,
  };
}
