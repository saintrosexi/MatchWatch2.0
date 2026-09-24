import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Clapperboard, Search, Star, X } from '../../ui/icons.js';
import { api, describeError } from '../../lib/api.js';
import { EmptyState, ErrorState, LoadingState, SkeletonGrid } from '../../ui/States.jsx';
import { Poster } from '../../ui/Poster.jsx';
import { trackMetric } from '../../lib/telemetry.js';
import { METRIC } from '../../../shared/telemetry/events.js';

/**
 * Star Hub: витрина актёров, профиль с фактами и фильмографией,
 * и главное — кнопка «собрать колоду только с ним».
 */
export function StarHubView({ onStartActorDeck, onOpenTitle, initialPersonId = null, embedded = false }) {
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadPopular = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.popularPeople(1);
      setPeople(payload.people ?? []);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPopular(); }, [loadPopular]);

  const openPerson = useCallback(async (id) => {
    setSelected({ loading: true, id });
    try {
      const payload = await api.person(id);
      setSelected({ loading: false, ...payload });
    } catch (e) {
      setSelected({ loading: false, error: describeError(e), id });
    }
  }, []);

  useEffect(() => {
    if (initialPersonId) openPerson(initialPersonId);
  }, [initialPersonId, openPerson]);

  /* Поиск актёров — с задержкой, чтобы не долбить прокси на каждую букву. */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) { if (!trimmed) loadPopular(); return undefined; }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const payload = await api.search(trimmed, 'person');
        setPeople(payload.people ?? []);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [query, loadPopular]);

  if (selected) {
    return (
      <PersonProfile
        data={selected}
        onBack={() => setSelected(null)}
        onStartDeck={(person) => {
          trackMetric(METRIC.STAR_DECK, { context: { personId: person.id } });
          onStartActorDeck(person);
        }}
        onOpenTitle={onOpenTitle}
        onRetry={() => openPerson(selected.id)}
      />
    );
  }

  return (
    <div className="view">
      {!embedded && (
        <header className="view__head">
          <h1 className="view__title">Звёзды</h1>
          <p className="view__sub">Откройте актёра — и соберите колоду только из его фильмов.</p>
        </header>
      )}

      <div className="row gap-2 surface" style={{ padding: '0 var(--s-4)', borderRadius: 'var(--r)' }}>
        <Search size={20} color="var(--text-low)" />
        <input
          className="input"
          style={{ background: 'none', border: 'none', minHeight: 46 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти актёра"
          aria-label="Поиск актёра"
        />
      </div>

      {error && <ErrorState error={error} onRetry={loadPopular} module="stars.hub" />}
      {!error && loading && <SkeletonGrid count={12} />}
      {!error && !loading && people.length === 0 && (
        <EmptyState
          icon={Star}
          title={query ? 'Никого не нашли' : 'Список актёров пуст'}
          text={query
            ? 'По такому имени актёров нет. Проверьте написание или попробуйте другое имя.'
            : 'Не получилось загрузить популярных актёров. Попробуйте ещё раз.'}
          action={query
            ? (
              <button type="button" className="btn btn--primary" onClick={() => setQuery('')}>
                <X size={16} /> Сбросить поиск
              </button>
            )
            : (
              <button type="button" className="btn btn--primary" onClick={loadPopular}>
                Обновить
              </button>
            )}
        />
      )}

      {!error && !loading && people.length > 0 && (
        <div className="star-grid">
          {people.map((person) => (
            <button key={person.id} type="button" className="star" onClick={() => openPerson(person.id)}>
              {person.photo
                ? <img className="star__photo" src={person.photo} alt="" loading="lazy" />
                : <div className="star__photo" />}
              {/* В общей сетке только фото и имя: перечень фильмов здесь
                  создаёт шум и мешает узнавать лицо. */}
              <span className="star__name">{person.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PersonProfile({ data, onBack, onStartDeck, onOpenTitle, onRetry }) {
  if (data.loading) return <LoadingState text="Открываем профиль…" />;
  if (data.error) return <ErrorState error={data.error} onRetry={onRetry} module="stars.hub" />;

  const { person, filmography = [] } = data;

  return (
    <div className="view">
      <button type="button" className="btn btn--quiet btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <ArrowLeft size={16} /> Все звёзды
      </button>

      <div className="star-hero">
        <div className="star-hero__top">
          {person.photoLarge
            ? <img className="star-hero__photo" src={person.photoLarge} alt={person.name} />
            : <div className="star-hero__photo" />}
          <div className="stack gap-2 grow">
            <h1 className="view__title">{person.name}</h1>
            {person.department && <span className="chip">{person.department}</span>}
            <div className="star-hero__facts">
              {person.facts.map((fact) => (
                <span className="star-hero__fact" key={fact}>{fact}</span>
              ))}
            </div>
          </div>
        </div>

        {person.biography && <p className="details__overview clamp-3">{person.biography}</p>}

        <button
          type="button"
          className="btn btn--primary btn--lg btn--block"
          onClick={() => onStartDeck(person)}
          disabled={filmography.length === 0}
        >
          <Clapperboard size={20} /> Колода из фильмов ({filmography.length})
        </button>
      </div>

      <section className="section">
        <h2 className="section__title">Фильмография</h2>
        <div className="poster-grid">
          {/*
            * Фильмография была витриной: постер видно, а нажать нельзя.
            * Человек приходит сюда посмотреть, что снял актёр, — и решение
            * о конкретном фильме принимается здесь же, а не после
            * возвращения в ленту.
            */}
          {filmography.map((movie) => (
            <button
              type="button"
              className="poster-card"
              key={movie.id}
              onClick={() => onOpenTitle?.(movie)}
              title={movie.title}
            >
              <Poster src={movie.poster} alt={movie.title} size="w342" />
              <span className="poster-card__cap truncate">{movie.title}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
