/**
 * GET /api/tmdb/catalog
 * Список фильмов под фильтры пользователя. Отдаёт «лёгкие» тайтлы:
 * теги выведены из жанров, детальные keywords подтягивает /api/tmdb/enrich.
 * Так первая карточка появляется быстро, а точность тегов догоняет фоном.
 *
 * Параметры: list, genres, yearFrom, yearTo, minRating, maxRuntime,
 *            originalLanguage, page, sort
 */

import { withHandler, badRequest } from '../_lib/http.js';
import { assertNonEmpty, getImageBase, tmdbFetch } from '../_lib/tmdb.js';
import { cached, cacheKeyFor, storeTitles, loadOverlays, TTL } from '../_lib/cache.js';
import { normalizeTmdbMovie } from '../../shared/model/title.js';
import { applyMarkup } from '../../shared/ai/markup.js';
import { applyCurated } from '../../shared/model/curated.js';
import { isExcluded } from '../../shared/config/excluded.js';
import { MODULE } from '../../shared/telemetry/events.js';
import { clampInt, toFloat } from '../_lib/util.js';

const LISTS = {
  popular: '/movie/popular',
  top_rated: '/movie/top_rated',
  now_playing: '/movie/now_playing',
  upcoming: '/movie/upcoming',
};

/**
 * Списки, привязанные к конкретному фильму.
 *
 * Это готовый коллаборативный сигнал: TMDB считает их по поведению
 * миллионов людей — «кто смотрел это, смотрел и то». Своей такой
 * статистики у нас нет и не будет ещё долго, а здесь она бесплатна.
 *
 * Именно из них строится пул кандидатов «похоже на то, что вы
 * полюбили». До этого пул набирался мировой популярностью, то есть
 * признаком, не имеющим к человеку никакого отношения.
 */
const RELATED = {
  similar: 'similar',
  recommendations: 'recommendations',
};

/**
 * Куда идём, когда `discover` лежит.
 *
 * У TMDB ручки падают поодиночке: 31.08.2026 `discover/movie` отдавал
 * 500 «Internal error», а `trending`, `popular` и даже `discover/tv`
 * работали. Приложение при этом показывало «Каталог TMDB недоступен»
 * и пустой экран — на одной сломанной ручке держалась вся лента.
 *
 * Эти списки не принимают фильтры, поэтому отбор по жанру, году
 * и рейтингу делается уже над ответом. Длительность отфильтровать
 * нечем: её в списочных ответах нет. Лента получается грубее — но
 * лента, а не экран с ошибкой.
 */
const FALLBACK_LISTS = ['/trending/movie/week', '/movie/popular', '/movie/top_rated'];

/**
 * Сколько живёт урезанная подборка.
 *
 * Обычный список кэшируется на шесть часов. Урезанный столько держать
 * нельзя: источник чинится за минуты, а мы раздавали бы грубую выборку
 * ещё полдня — и полосу «у TMDB сбой» вместе с ней. Пять минут — это
 * и защита от долбёжки в лежащую ручку, и быстрый возврат к норме.
 */
const DEGRADED_TTL = 5 * 60_000;

const SORTS = {
  popularity: 'popularity.desc',
  rating: 'vote_average.desc',
  newest: 'primary_release_date.desc',
  revenue: 'revenue.desc',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Продукт отвечает на вопрос «что посмотреть сегодня», поэтому ещё не
 * вышедшие фильмы — это шум: их нельзя включить вечером. TMDB же охотно
 * подмешивает их в «популярное» на волне трейлеров и анонсов.
 *
 * Списочные эндпоинты фильтра по дате не принимают, поэтому отсекаем
 * после получения; в discover ограничение уходит прямо в запрос.
 */
const isReleased = (raw) => {
  const date = raw?.release_date;
  if (!date) return false;
  return date <= today();
};

export default withHandler({ methods: ['GET'], module: MODULE.TMDB_PROXY, cacheSeconds: 900 }, async ({ query }) => {
  const list = query.get('list') ?? 'discover';
  const page = clampInt(query.get('page'), 1, 500, 1);
  const genres = (query.get('genres') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const yearFrom = clampInt(query.get('yearFrom'), 1900, 2100, null);
  const yearTo = clampInt(query.get('yearTo'), 1900, 2100, null);
  const minRating = toFloat(query.get('minRating'), null);
  /*
   * Потолок длительности. Появился ради запросов словами: «не длиннее
   * двух часов» люди называют часто, и это ровно то жёсткое условие,
   * которое человек выдвинул прямо, а не то, что за него угадали.
   */
  const maxRuntime = clampInt(query.get('maxRuntime'), 40, 400, null);
  /*
   * Язык оригинала. Нужен для подборок вроде русского кино: без него
   * отобрать «наше» нечем — по стране производства TMDB отдаёт и
   * копродукции, где от нашего кино только деньги.
   */
  const originalLanguage = (query.get('originalLanguage') ?? '').trim().slice(0, 8) || null;
  const sort = SORTS[query.get('sort')] ?? SORTS.popularity;
  const language = query.get('language') ?? 'ru-RU';

  const relatedTo = RELATED[list] ? clampInt(query.get('id'), 1, 99999999, null) : null;
  if (RELATED[list] && !relatedTo) {
    // Список «похожих» без фильма — это не список, а ошибка вызова.
    throw badRequest('id_required', `Для списка «${list}» нужен id фильма`);
  }

  const isDiscover = !LISTS[list] && !relatedTo;
  const path = relatedTo
    ? `/movie/${relatedTo}/${RELATED[list]}`
    : (isDiscover ? '/discover/movie' : LISTS[list]);

  // Верхняя граница по дате — минимум из «не позже выбранного года»
  // и «уже вышло»: будущие премьеры в выбор не попадают.
  const upperBound = yearTo && `${yearTo}-12-31` < today() ? `${yearTo}-12-31` : today();

  const params = isDiscover
    ? {
        page, language, sort_by: sort,
        include_adult: false,
        with_genres: genres.length ? genres.join(',') : undefined,
        'primary_release_date.gte': yearFrom ? `${yearFrom}-01-01` : undefined,
        'primary_release_date.lte': upperBound,
        'vote_average.gte': minRating ?? undefined,
        'with_runtime.lte': maxRuntime ?? undefined,
        with_original_language: originalLanguage ?? undefined,
        /*
         * Порог голосов нужен против шума: без него discover вытаскивает
         * случайные записи с оценкой 10 и тремя голосами.
         *
         * Но шестьдесят — это много для старого и нишевого кино: у
         * «Кавказской пленницы» на TMDB двадцать девять голосов. Порог
         * снижен до двадцати пяти, и заодно поднят минимальный рейтинг,
         * когда человек его не задал: шум отсекается им, а не голосами.
         */
        'vote_count.gte': minRating ? 200 : 25,
      }
    : { page, language };

  /*
   * Идентификатор фильма обязан входить в ключ кэша. Списки «похожих»
   * получают одни и те же параметры (страница и язык), и без него
   * похожие на «Брата» и похожие на «Дюну» легли бы в одну ячейку —
   * второй запрос молча получил бы чужой ответ.
   */
  const key = `catalog/lists/${cacheKeyFor(relatedTo ? `${list}-${relatedTo}` : list, params)}`;

  const { value, source } = await cached(key, TTL.LIST, async () => {
    const [{ payload, degraded }, imageBase] = await Promise.all([
      fetchList({ isDiscover, path, params, page, language }),
      getImageBase(),
    ]);

    const fetched = assertNonEmpty(payload?.results ?? [], { path, params });
    /*
     * В запасном режиме условия приходится применять руками: списочные
     * ручки их не принимают. Если после отбора почти ничего не осталось,
     * отдаём как есть — редкий фильтр не повод показать пустой экран
     * поверх и без того сломанного каталога.
     */
    const narrowed = degraded
      ? fetched.filter((r) => matchesFilters(r, { genres, yearFrom, yearTo, minRating }))
      : fetched;
    /*
     * Порог, ниже которого фильтры отбрасываются целиком.
     *
     * Считается от порции, а не от абсолютного числа: из шестидесяти
     * сырых записей десять выживших — это ещё подборка, а три —
     * уже повод для «полистал и жди». Пустой экран поверх сломанного
     * каталога хуже, чем подборка грубее заказанной.
     */
    const results = degraded && narrowed.length < 10 ? fetched : narrowed;

    const titles = results
      .filter(isReleased)
      .map((raw) => normalizeTmdbMovie(raw, { imageBase }))
      .filter((t) => t && t.poster)
      // Постоянное исключение — до кэша, иначе исключённое осело бы в нём
      // на шесть часов и всплывало бы, пока срок не выйдет.
      .filter((t) => !isExcluded(t));

    // Каталог кладём в общее хранилище: клиенты читают его напрямую из базы.
    storeTitles(titles);

    return {
      degraded,
      titles,
      page: payload?.page ?? page,
      totalPages: Math.min(payload?.total_pages ?? 1, 500),
      totalResults: payload?.total_results ?? titles.length,
    };
  }, (result) => (result?.degraded ? DEGRADED_TTL : TTL.LIST));

  /*
   * Разметка подмешивается ПОСЛЕ кэша, а не внутри него.
   *
   * Список живёт шесть часов. Подмешав внутри, мы получили бы разметку
   * на экране только после того, как кэш протухнет, — то есть спустя
   * полдня после прогона. Снаружи она действует сразу.
   */
  const titles = await withMarkup(value.titles);

  return { ...value, titles, enriched: false, cacheSource: source };
});

/**
 * Накладывает оба слоя. Порядок важен: ручной отбор идёт последним,
 * потому что решение человека главнее предположения модели.
 */
async function withMarkup(titles) {
  if (!titles?.length) return titles;
  const { markup, curated } = await loadOverlays(titles.map((t) => t.id));
  if (!markup.size && !curated.size) return titles;

  return titles.map((title) => {
    const withModel = markup.has(title.id) ? applyMarkup(title, markup.get(title.id)) : title;
    return curated.has(title.id) ? applyCurated(withModel, curated.get(title.id)) : withModel;
  });
}

/**
 * До какого момента не трогаем `discover`.
 *
 * Отказы у TMDB идут пачками: замер 31.08.2026 дал восемь отказов
 * подряд, потом четыре нормальных ответа. Ходить в лежащую ручку
 * на КАЖДУЮ дозагрузку — значит платить несколько секунд ожидания
 * снова и снова: человек листает четыре карточки и опять ждёт.
 *
 * Поэтому первый отказ закрывает ручку на минуту. Минута короче
 * средней пачки отказов и достаточно коротка, чтобы вернуться
 * к нормальной выдаче почти сразу после того, как TMDB починится.
 */
let discoverDownUntil = 0;
const DISCOVER_COOLDOWN_MS = 60_000;

/**
 * Сколько страниц запасного списка склеиваем в одну свою.
 *
 * Списочная страница TMDB — это двадцать записей, из которых после
 * отсева невышедшего, беспостерного и не подошедшего под фильтры
 * остаётся четыре-пять. Колоде нужно двадцать пять, и она просит
 * добавки снова и снова — а каждая просьба это отдельное ожидание.
 *
 * Три страницы разом дают шестьдесят сырых записей: после отсева
 * набирается порция, с которой можно листать, а не ждать.
 */
const FALLBACK_PAGES = 3;

/**
 * Забирает список, переживая падение `discover`.
 *
 * Попыток на `discover` намеренно МЕНЬШЕ обычного: при лежащей ручке
 * каждая стоит несколько секунд, и полный круг повторов складывался
 * в восемнадцать секунд ожидания перед экраном с ошибкой. Быстрее
 * признать, что ручка не отвечает, и взять живой список: человеку
 * нужна лента, а не наша настойчивость.
 */
async function fetchList({ isDiscover, path, params, page, language }) {
  if (!isDiscover) return { payload: await tmdbFetch(path, params), degraded: false };

  if (Date.now() < discoverDownUntil) return fetchFallback({ page, language });

  try {
    const payload = await tmdbFetch(path, params, { retries: 1 });
    discoverDownUntil = 0;
    return { payload, degraded: false };
  } catch (error) {
    discoverDownUntil = Date.now() + DISCOVER_COOLDOWN_MS;
    try {
      return await fetchFallback({ page, language });
    } catch {
      /* Лёг весь TMDB — честнее отдать исходную ошибку. */
      throw error;
    }
  }
}

/**
 * Запасная выдача: несколько страниц здорового списка разом.
 *
 * Страницы берутся подряд и параллельно — одна порция вместо трёх
 * отдельных ожиданий. Наша страница `page` раскладывается в свой
 * непрерывный отрезок чужих страниц, поэтому листание вперёд даёт
 * новые фильмы, а не те же самые.
 */
async function fetchFallback({ page, language }) {
  for (const fallback of FALLBACK_LISTS) {
    const first = (page - 1) * FALLBACK_PAGES + 1;
    const pages = Array.from({ length: FALLBACK_PAGES }, (_, i) => first + i)
      .filter((n) => n <= 500);

    const parts = await Promise.all(pages.map((n) => (
      tmdbFetch(fallback, { page: n, language }, { retries: 1 }).catch(() => null)
    )));

    const results = parts.flatMap((part) => part?.results ?? []);
    if (results.length) {
      const head = parts.find(Boolean);
      return {
        payload: {
          results,
          page,
          /* Страниц у нас втрое меньше: в каждой лежит три чужих. */
          total_pages: Math.ceil((head?.total_pages ?? 1) / FALLBACK_PAGES),
          total_results: head?.total_results ?? results.length,
        },
        degraded: true,
      };
    }
  }

  throw new Error('запасные списки TMDB тоже не ответили');
}

/**
 * Условия отбора поверх готового списка.
 *
 * Только то, что есть в списочном ответе: жанры, дата выхода, оценка.
 * Длительности там нет, и делать вид, что мы её учли, нельзя.
 *
 * Жанры совпадают ПО ВСЕМ запрошенным, как в `discover` с перечислением
 * через запятую: иначе «драма + детектив» превратилось бы в «драма или
 * детектив» и человек получил бы не то, что просил.
 */
export function matchesFilters(raw, { genres = [], yearFrom, yearTo, minRating } = {}) {
  if (genres.length) {
    const ids = new Set((raw.genre_ids ?? []).map(String));
    if (!genres.every((g) => ids.has(String(g)))) return false;
  }

  const year = Number((raw.release_date ?? '').slice(0, 4));
  if (yearFrom && !(year >= yearFrom)) return false;
  if (yearTo && !(year <= yearTo)) return false;

  if (minRating && !((raw.vote_average ?? 0) >= minRating)) return false;

  return true;
}
