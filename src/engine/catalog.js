/**
 * Поставщик кандидатов для колоды.
 *
 * Работает в две волны: сначала «лёгкие» тайтлы (быстро, теги из жанров),
 * следом фоновое обогащение детальными keywords. Колода пересобирается,
 * когда обогащение приезжает, — пользователь этого не замечает, а точность
 * тегов вырастает на порядок.
 */

import { api, describeError } from '../lib/api.js';
import { trackBusiness, trackError } from '../lib/telemetry.js';
import { BIZ, MODULE } from '../../shared/telemetry/events.js';
import { parseTitleId } from '../../shared/model/title.js';
import { getConfig } from './recommendationConfig.js';
import { COLD_START_IDS } from '../../shared/config/coldStart.js';

export class CatalogPool {
  constructor({ filters = {}, onUpdate, seeds = [] } = {}) {
    /** Каталог пришёл в урезанном виде — см. `loadMore`. */
    this.degraded = false;
    this.filters = filters;
    this.onUpdate = onUpdate;
    /**
     * Любимые фильмы, от которых пляшет отбор кандидатов.
     *
     * До них пул набирался одной мировой популярностью — признаком,
     * не имеющим к человеку никакого отношения. Ранжирование потом
     * сортировало этот список вкусом, но выбрать из плохой выборки
     * хорошее нельзя: у всех пользователей пул был один и тот же,
     * отличался только порядок.
     */
    this.seeds = seeds;
    this.seedIndex = 0;
    this.seedsDone = false;
    this.titles = new Map();     // id -> title
    this.page = 0;
    this.totalPages = 1;
    this.loading = false;
    this.enriching = new Set();
    this.exhausted = false;
    this.lastError = null;
    this.primed = false;
  }

  get all() { return [...this.titles.values()]; }
  get size() { return this.titles.size; }

  setSeeds(seeds) {
    this.seeds = seeds ?? [];
    this.seedIndex = 0;
    this.seedsDone = false;
  }

  /**
   * Горячее семя — фильм, который человек лайкнул прямо сейчас.
   *
   * Обычные семена ставятся один раз, при сборке колоды, и из-за этого
   * лента могла повернуть только внутри уже загруженных кандидатов:
   * пересортировка хвоста меняла порядок, но не состав. Горячее семя
   * встаёт первым в очередь и тянет из каталога НОВОЕ похожее — то самое
   * поведение маркетплейса, ради которого режим поиска и делался.
   *
   * Уже отработанные семена не возвращаются: их выдача давно в пуле,
   * и повторный запрос стоил бы двух вызовов ради тех же карточек.
   */
  pushSeed(id) {
    if (!id) return false;
    const pending = this.seeds.slice(this.seedIndex).filter((seed) => seed !== id);
    this.seeds = [id, ...pending];
    this.seedIndex = 0;
    this.seedsDone = false;
    return true;
  }

  setFilters(filters) {
    this.filters = filters;
    this.titles.clear();
    this.page = 0;
    this.totalPages = 1;
    this.exhausted = false;
    this.lastError = null;
    this.primed = false;
  }

  /** Подтягивает следующую страницу каталога. Возвращает число новых тайтлов. */
  async loadMore({ signal } = {}) {
    if (this.loading || this.exhausted) return 0;
    this.loading = true;
    this.lastError = null;

    try {
      const next = this.page + 1;
      if (next > this.totalPages) { this.exhausted = true; return 0; }

      const params = buildParams(this.filters, next);
      const payload = await api.catalog(params, { signal });

      this.page = payload.page ?? next;
      this.totalPages = payload.totalPages ?? 1;
      /*
       * Каталог отдан запасным путём: у TMDB лежит `discover`, и часть
       * условий отбора применить было нечем. Человеку об этом надо
       * сказать — иначе он видит, что фильтры не сработали, и делает
       * вывод, что сломались мы.
       */
      this.degraded = Boolean(payload.degraded);

      let added = 0;
      for (const title of payload.titles ?? []) {
        if (this.titles.has(title.id)) continue;
        this.titles.set(title.id, title);
        added += 1;
      }

      if (added === 0 && this.page >= this.totalPages) this.exhausted = true;
      if (this.size === 0) {
        trackBusiness(BIZ.DECK_EMPTY_AFTER_FILTERS, {
          module: MODULE.CATALOG, context: { ...params },
        });
      }

      this.onUpdate?.(this.all);
      return added;
    } catch (error) {
      this.lastError = describeError(error);
      if (!['offline', 'timeout', 'network'].includes(error?.code)) {
        trackError('Не удалось загрузить каталог', {
          module: MODULE.CATALOG, error, context: { page: this.page + 1, filters: this.filters },
        });
      }
      throw error;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Подтягивает похожих на один из любимых фильмов.
   *
   * Это готовый коллаборативный сигнал TMDB, посчитанный на миллионах
   * людей: «кто смотрел это, смотрел и то». Своей такой статистики
   * у нас не будет ещё долго, а эта бесплатна.
   *
   * За вызов берётся ОДНА опора, а не все сразу. Сорок запросов подряд
   * задержали бы первую карточку на секунды ради выборки, которую
   * человек, может быть, и не долистает.
   */
  async loadSimilar({ signal } = {}) {
    if (this.seedsDone) return 0;

    /*
     * Семян нет вовсе — у новичка или пока история не приехала.
     * Пометить себя законченным здесь обязательно: иначе наполнение
     * пула через раз уходило бы в пустой вызов, и пул недобирал вдвое.
     */
    if (!this.seeds.length) { this.seedsDone = true; return 0; }

    const seed = this.seeds[this.seedIndex];
    this.seedIndex += 1;
    if (this.seedIndex >= this.seeds.length) this.seedsDone = true;

    const externalId = Number(parseTitleId(seed)?.externalId);
    if (!Number.isFinite(externalId)) return 0;

    try {
      /*
       * Два списка на опору: `recommendations` ближе к «вам зайдёт»,
       * `similar` — к «того же рода». Вместе они шире, чем любой
       * по отдельности, а стоят одинаково.
       */
      const [recs, similar] = await Promise.all([
        api.catalog({ list: 'recommendations', id: externalId, page: 1 }, { signal }).catch(() => null),
        api.catalog({ list: 'similar', id: externalId, page: 1 }, { signal }).catch(() => null),
      ]);

      let added = 0;
      for (const payload of [recs, similar]) {
        for (const title of payload?.titles ?? []) {
          if (!title?.id || this.titles.has(title.id)) continue;
          this.titles.set(title.id, title);
          added += 1;
        }
      }

      if (added) this.onUpdate?.(this.all);
      return added;
    } catch {
      // Похожие — приятная добавка, а не условие работы каталога.
      return 0;
    }
  }

  /**
   * Подмешивает стартовый набор.
   *
   * Полагаться на то, что эти пятнадцать фильмов и так попадутся в выдаче
   * популярного, нельзя: состав популярного меняется каждую неделю, а
   * набор должен приезжать всегда. Грузится он один раз за сессию пула
   * и параллельно первой странице, поэтому первую карточку не задерживает.
   */
  async primeColdStart({ signal } = {}) {
    if (this.primed) return 0;
    this.primed = true;

    try {
      const payload = await api.enrich(COLD_START_IDS, { signal });
      let added = 0;
      for (const title of payload.titles ?? []) {
        if (this.titles.has(title.id)) continue;
        this.titles.set(title.id, { ...title, enriched: true });
        added += 1;
      }
      if (added) this.onUpdate?.(this.all);
      return added;
    } catch (error) {
      // Набор — улучшение, а не условие работы: без него лента живёт.
      trackError('Не удалось подгрузить стартовый набор', {
        module: MODULE.CATALOG, error,
      });
      return 0;
    }
  }

  /**
   * Догружает детальные теги для ближайших карточек.
   * Вызывать оптимистично: повторный запрос по тому же id почти бесплатен
   * (кэш на сервере), а точность ранжирования растёт заметно.
   */
  async enrich(ids, { signal } = {}) {
    const pending = ids
      .map((id) => (typeof id === 'string' ? id : id?.id))
      .filter((id) => id && !this.enriching.has(id) && this.titles.get(id)?.enriched !== true)
      .slice(0, 24);
    if (!pending.length) return 0;

    pending.forEach((id) => this.enriching.add(id));

    try {
      const externalIds = pending
        .map((id) => Number(parseTitleId(id)?.externalId))
        .filter(Number.isFinite);
      if (!externalIds.length) return 0;

      const payload = await api.enrich(externalIds, { signal });
      let updated = 0;
      for (const title of payload.titles ?? []) {
        this.titles.set(title.id, { ...this.titles.get(title.id), ...title, enriched: true });
        updated += 1;
      }
      if (updated) this.onUpdate?.(this.all);
      return updated;
    } catch (error) {
      // Обогащение — улучшение, а не обязательство: молча остаёмся на жанровых тегах.
      trackBusiness(BIZ.TMDB_UPSTREAM_ERROR, {
        module: MODULE.CATALOG, context: { phase: 'enrich', reason: error?.code ?? 'unknown' },
      });
      return 0;
    } finally {
      pending.forEach((id) => this.enriching.delete(id));
    }
  }

  /**
   * Загружает страницы, пока не наберётся пул нужного размера.
   *
   * Лимит страниц выводится из цели, а не из константы: раньше он был
   * жёстко равен шести, поэтому пул физически не мог дорасти до
   * заявленных в конфиге 320 карточек.
   */
  async fill(targetSize = getConfig().deck.candidatePool, { signal, maxPages } = {}) {
    const remaining = Math.max(0, targetSize - this.size);
    const limit = maxPages ?? Math.min(25, Math.ceil(remaining / 20) + 2);

    let pages = 0;
    while (this.size < targetSize && pages < limit) {
      /*
       * Похожие на любимые идут первыми и чередуются с популярным.
       *
       * Первыми — потому что это лучшая часть выборки: фильмы, которых
       * человек не видел, но которые смотрели те, кому нравилось то же
       * самое. Чередуются — потому что одними похожими пул схлопнется
       * в пузырь вокруг уже любимого, а разведке нужен материал извне.
       */
      const added = !this.seedsDone && pages % 2 === 0
        ? await this.loadSimilar({ signal })
        : await this.loadMore({ signal });

      pages += 1;
      if (added === 0 && this.exhausted && this.seedsDone) break;
    }
    return this.size;
  }
}

function buildParams(filters, page) {
  const params = { page, list: 'discover' };
  if (filters.genres?.length) params.genres = filters.genres.join(',');
  if (filters.yearFrom) params.yearFrom = filters.yearFrom;
  if (filters.yearTo) params.yearTo = filters.yearTo;
  if (filters.minRating) params.minRating = filters.minRating;
  if (filters.maxRuntime) params.maxRuntime = filters.maxRuntime;
  if (filters.originalLanguage) params.originalLanguage = filters.originalLanguage;
  if (filters.sort) params.sort = filters.sort;
  if (filters.list) params.list = filters.list;
  return params;
}

/** Колода по конкретному актёру — «мгновенно все фильмы с ним». */
export async function loadActorDeck(personId, { signal } = {}) {
  const payload = await api.person(personId, { signal });
  return { person: payload.person, titles: payload.filmography ?? [] };
}
