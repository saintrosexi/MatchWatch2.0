import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, SlidersHorizontal, Star, X } from '../../ui/icons.js';
import { api, describeError } from '../../lib/api.js';
import { Poster } from '../../ui/Poster.jsx';
import { EmptyState, ErrorState, SkeletonGrid } from '../../ui/States.jsx';
import { GENRE_LIST } from '../../../shared/taxonomy/genres.js';
import { withPlural, FORMS } from '../../../shared/i18n/plural.js';

const RATINGS = [
  { value: 0, label: 'любой' },
  { value: 6, label: '6+' },
  { value: 7, label: '7+' },
  { value: 7.5, label: '7,5+' },
  { value: 8, label: '8+' },
];

const SORTS = [
  { key: 'popularity', label: 'Популярное' },
  { key: 'rating', label: 'По рейтингу' },
  { key: 'newest', label: 'Новинки' },
];

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Каталог целиком — просмотр без свайпов.
 *
 * Свайп-лента отвечает на вопрос «что мне посмотреть», а этот экран —
 * на «покажи всё и дай выбрать самому». Поэтому здесь нет ранжирования
 * по вкусу: только честные фильтры и порядок, который выбрал пользователь.
 */
export function CatalogBrowser({ onOpenTitle, history = {} }) {
  const [filters, setFilters] = useState({ minRating: 7, genres: [], sort: 'popularity', yearFrom: null });
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (nextPage, { append }) => {
    const myGeneration = ++generation.current;
    setLoading(true);
    setError(null);

    try {
      const trimmed = query.trim();
      const payload = trimmed.length >= 2
        ? await api.search(trimmed, 'movie')
        : await api.catalog({
          page: nextPage,
          minRating: filters.minRating || undefined,
          genres: filters.genres.length ? filters.genres.join(',') : undefined,
          sort: filters.sort,
          yearFrom: filters.yearFrom ?? undefined,
        });

      if (generation.current !== myGeneration) return;

      const titles = payload.titles ?? [];
      setItems((prev) => (append ? dedupe([...prev, ...titles]) : titles));
      setTotalPages(payload.totalPages ?? 1);
      setPage(nextPage);
    } catch (e) {
      if (generation.current === myGeneration) setError(describeError(e));
    } finally {
      if (generation.current === myGeneration) setLoading(false);
    }
  }, [filters, query]);

  // Поиск с задержкой: не дёргаем прокси на каждую букву.
  useEffect(() => {
    const timer = setTimeout(() => load(1, { append: false }), query.trim() ? 400 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  const patch = (fields) => setFilters((f) => ({ ...f, ...fields }));
  const toggleGenre = (id) => patch({
    genres: filters.genres.includes(id)
      ? filters.genres.filter((g) => g !== id)
      : [...filters.genres, id].slice(0, 3),
  });

  const searching = query.trim().length >= 2;
  const canLoadMore = !searching && page < totalPages && !loading;

  return (
    <div className="view">
      <div className="catalog__controls">
        <div className="catalog__search">
          <Search size={16} color="var(--text-low)" />
          <input
            className="input"
            style={{ background: 'none', border: 'none', minHeight: 44 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти фильм"
            aria-label="Поиск по каталогу"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Очистить">
              <X size={16} color="var(--text-low)" />
            </button>
          )}
        </div>

        <button
          type="button"
          className={`btn btn--sm ${showFilters ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={16} />
          {filters.genres.length > 0 && <span className="catalog__badge">{filters.genres.length}</span>}
        </button>
      </div>

      {!searching && (
        <div className="catalog__ratings" role="group" aria-label="Минимальный рейтинг">
          {RATINGS.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`chip chip--interactive ${filters.minRating === r.value ? 'chip--on' : ''}`}
              aria-pressed={filters.minRating === r.value}
              onClick={() => patch({ minRating: r.value })}
            >
              {r.value > 0 && <Star size={12} weight="fill" />}
              {r.label}
            </button>
          ))}
        </div>
      )}

      {showFilters && !searching && (
        <div className="surface catalog__panel">
          <div className="filters__group">
            <span className="eyebrow">Жанр {filters.genres.length ? `(${filters.genres.length}/3)` : ''}</span>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              {GENRE_LIST.map((genre) => (
                <button
                  key={genre.id}
                  type="button"
                  className={`chip chip--interactive ${filters.genres.includes(genre.id) ? 'chip--on' : ''}`}
                  aria-pressed={filters.genres.includes(genre.id)}
                  onClick={() => toggleGenre(genre.id)}
                >
                  {genre.ru}
                </button>
              ))}
            </div>
          </div>

          <div className="filters__group">
            <span className="eyebrow">Порядок</span>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              {SORTS.map((sort) => (
                <button
                  key={sort.key}
                  type="button"
                  className={`chip chip--interactive ${filters.sort === sort.key ? 'chip--on' : ''}`}
                  aria-pressed={filters.sort === sort.key}
                  onClick={() => patch({ sort: sort.key })}
                >
                  {sort.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filters__group">
            <span className="eyebrow">Не старше</span>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              {[null, 2020, 2010, 2000, 1980].map((year) => (
                <button
                  key={String(year)}
                  type="button"
                  className={`chip chip--interactive ${filters.yearFrom === year ? 'chip--on' : ''}`}
                  aria-pressed={filters.yearFrom === year}
                  onClick={() => patch({ yearFrom: year })}
                >
                  {year ? `с ${year}` : 'любой год'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && <ErrorState error={error} onRetry={() => load(1, { append: false })} module="catalog.browse" />}

      {!error && loading && items.length === 0 && <SkeletonGrid count={12} />}

      {!error && !loading && items.length === 0 && (
        <EmptyState
          icon={Search}
          title="Ничего не нашлось"
          text={searching
            ? 'По такому названию фильмов нет. Проверьте написание или попробуйте другое.'
            : 'Под такие фильтры фильмов нет: рейтинг, жанры и год вместе отсекли всё.'}
          action={searching
            ? (
              <button type="button" className="btn btn--primary" onClick={() => setQuery('')}>
                <X size={16} /> Сбросить поиск
              </button>
            )
            : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setFilters({ minRating: 0, genres: [], sort: 'popularity', yearFrom: null })}
              >
                Сбросить фильтры
              </button>
            )}
        />
      )}

      {items.length > 0 && (
        <>
          <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
            {searching ? 'Результаты поиска' : `Найдено ${withPlural(items.length, FORMS.MOVIE)}`}
            {!searching && totalPages > 1 && ` · страница ${page} из ${totalPages}`}
          </p>

          <div className="poster-grid">
            {items.map((title) => (
              <button
                type="button"
                className="poster-card"
                key={title.id}
                data-watched={history[title.id] === 'watched' ? 'true' : undefined}
                onClick={() => onOpenTitle?.(title)}
              >
                <Poster src={title.poster} alt={title.title} size="w342" />
                <span className="poster-card__cap truncate">{title.title}</span>
                {title.rating > 0 && (
                  <span className="poster-card__rating">
                    <Star size={12} weight="fill" /> {title.rating.toFixed(1)}
                  </span>
                )}
              </button>
            ))}
          </div>

          {canLoadMore && (
            <button
              type="button"
              className="btn btn--ghost btn--wide"
              onClick={() => load(page + 1, { append: true })}
            >
              Показать ещё
            </button>
          )}
          {loading && items.length > 0 && <div className="spinner" style={{ margin: '0 auto' }} />}
        </>
      )}
    </div>
  );
}

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
};
