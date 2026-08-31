import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Check, ICON, Search, UserMinus, UserPlus, Users, X } from '../../ui/icons.js';
import { EmptyState, LoadingState } from '../../ui/States.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { Poster } from '../../ui/Poster.jsx';
import {
  acceptFriend, loadFriends, loadSuggestedFriends, loadSharedWatchlist, removeFriend,
  requestFriend, searchPeople,
} from '../../engine/social.js';

/**
 * «Друзья»: поиск людей и список связей.
 *
 * Поиск по нику работает с первых букв, по почте — только целиком.
 * Это не придирка к удобству: поиск по части адреса позволил бы
 * перебором вычерпать базу пользователей.
 */
export function FriendsView({ me, onOpenProfile, onOpenTitle, toasts }) {
  const [shared, setShared] = useState(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState([]);
  const [friends, setFriends] = useState([]);
  const [suggested, setSuggested] = useState([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    loadFriends()
      .then(setFriends)
      .catch(() => setFriends([]))
      .finally(() => setLoading(false));

    /* Подсказки — украшение экрана, а не условие его работы. */
    loadSuggestedFriends()
      .then(setSuggested)
      .catch(() => setSuggested([]));
  }, []);

  useEffect(refresh, [refresh]);

  // Поиск с задержкой: не дёргаем базу на каждую букву.
  useEffect(() => {
    const trimmed = query.trim();
    // Три символа — тот же порог, что и на сервере: иначе поиск молча
    // возвращает пустоту и выглядит сломанным.
    if (trimmed.length < 3) { setFound([]); return undefined; }

    setSearching(true);
    const timer = setTimeout(() => {
      searchPeople(trimmed)
        .then(setFound)
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 350);

    return () => clearTimeout(timer);
  }, [query]);

  const act = async (fn, person, message) => {
    try {
      await fn(person.id);
      refresh();
      if (message) toasts.success(message);
    } catch (error) {
      toasts.error(error?.message ?? 'Не получилось');
    }
  };

  /**
   * Что вы оба собираетесь посмотреть.
   *
   * Показываем только пересечение: чужой список целиком — это чужие
   * планы на вечер, а совпавшее обе стороны и так собирались обсуждать.
   */
  const compare = async (person) => {
    setShared({ person, loading: true, items: [] });
    try {
      const items = await loadSharedWatchlist(person.id);
      setShared({ person, loading: false, items });
    } catch (error) {
      setShared(null);
      toasts.error(error?.message ?? 'Не удалось сверить списки');
    }
  };

  const accepted = friends.filter((f) => f.status === 'accepted');
  const incoming = friends.filter((f) => f.status === 'pending' && f.requestedBy !== me?.uid);
  const outgoing = friends.filter((f) => f.status === 'pending' && f.requestedBy === me?.uid);
  const known = new Set(friends.map((f) => f.id));

  return (
    <div className="view">
      <header className="view__head">
        <h1 className="view__title">Друзья</h1>
        <p className="view__sub">Найдите человека по нику или почте — и зовите в комнату.</p>
      </header>

      <div className="catalog__search">
        <Search size={16} color="var(--text-low)" />
        <input
          className="input"
          style={{ background: 'none', border: 'none', minHeight: 44 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ник или почта"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Поиск людей"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Очистить">
            <X size={16} color="var(--text-low)" />
          </button>
        )}
      </div>

      {/*
        * Подсказки по вкусу.
        *
        * Показываются, когда человек НЕ ищет: во время поиска он знает,
        * кого хочет найти, и подсовывать ему других — мешать. Причина
        * показа названа прямо числом общих любимых: без неё это просто
        * список незнакомцев, который никто не открывает.
        */}
      {!query.trim() && suggested.length > 0 && (
        <section className="section">
          <h2 className="section__title">Похожий вкус</h2>
          <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
            Эти люди любят то же, что и вы. Телефонная книжка такого не знает.
          </p>
          <div className="stack gap-2">
            {suggested.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                /* Коротко: строку сжимает кнопка справа, длинная фраза обрезается. */
                subtitle={`${person.shared} общих любимых`}
                onOpen={() => onOpenProfile(person.username)}
                action={(
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={() => act(requestFriend, person, `Заявка отправлена ${person.displayName}`)}
                  >
                    <UserPlus size={16} /> Добавить
                  </button>
                )}
              />
            ))}
          </div>
        </section>
      )}

      {query.trim().length >= 3 && (
        <section className="section">
          <h2 className="section__title">Результаты</h2>
          {searching && <div className="spinner" style={{ margin: '0 auto' }} />}
          {!searching && found.length === 0 && (
            <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
              Никого не нашли. Ник ищется с первых трёх букв, почта — целиком.
            </p>
          )}
          <div className="stack gap-2">
            {found.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                onOpen={() => onOpenProfile(person.username)}
                action={known.has(person.id) ? null : (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={() => act(requestFriend, person, `Заявка отправлена ${person.displayName}`)}
                  >
                    <UserPlus size={16} /> Добавить
                  </button>
                )}
              />
            ))}
          </div>
        </section>
      )}

      {loading && <LoadingState text="Загружаем друзей…" />}

      {!loading && incoming.length > 0 && (
        <section className="section">
          <h2 className="section__title">Входящие заявки</h2>
          <div className="stack gap-2">
            {incoming.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                onOpen={() => onOpenProfile(person.username)}
                action={(
                  <div className="row gap-2">
                    <button type="button" className="btn btn--sm btn--primary"
                      onClick={() => act(acceptFriend, person, `${person.displayName} теперь в друзьях`)}>
                      <Check size={16} /> Принять
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost"
                      onClick={() => act(removeFriend, person, 'Заявка отклонена')}>
                      <X size={16} />
                    </button>
                  </div>
                )}
              />
            ))}
          </div>
        </section>
      )}

      {!loading && (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Мои друзья</h2>
            {accepted.length > 0 && <span className="faint" style={{ fontSize: 'var(--t-small)' }}>{accepted.length}</span>}
          </div>

          {accepted.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Пока никого"
              text="Найдите человека по нику или почте — вместе выбирать кино интереснее."
            />
          ) : (
            <div className="stack gap-2">
              {accepted.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  onOpen={() => onOpenProfile(person.username)}
                  action={(
                    <div className="row gap-2">
                      {/* Сверка списков: то, что оба уже отложили, —
                          готовый ответ на «что посмотрим сегодня». */}
                      <button type="button" className="btn btn--sm btn--ghost"
                        onClick={() => compare(person)}
                        aria-label={`Сверить списки с ${person.displayName}`}
                        title="Сверить «буду смотреть»">
                        <Bookmark size={16} />
                      </button>
                      <button type="button" className="btn btn--sm btn--quiet"
                        onClick={() => act(removeFriend, person, 'Убрали из друзей')}
                        aria-label="Убрать из друзей">
                        <UserMinus size={16} />
                      </button>
                    </div>
                  )}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {!loading && outgoing.length > 0 && (
        <section className="section">
          <h2 className="section__title">Отправленные заявки</h2>
          <div className="stack gap-2">
            {outgoing.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                onOpen={() => onOpenProfile(person.username)}
                action={(
                  <button type="button" className="btn btn--sm btn--quiet"
                    onClick={() => act(removeFriend, person, 'Заявка отозвана')}>
                    Отозвать
                  </button>
                )}
              />
            ))}
          </div>
        </section>
      )}

      <Sheet
        open={Boolean(shared)}
        onClose={() => setShared(null)}
        title={shared ? `Оба хотим посмотреть · ${shared.person.displayName}` : ''}
      >
        {shared?.loading && <LoadingState text="Сверяем списки…" />}

        {shared && !shared.loading && shared.items.length === 0 && (
          <EmptyState
            icon={Bookmark}
            title="Совпадений нет"
            text="Пока вы отложили разное. Посвайпайте ещё — или заведите комнату и выберите вместе."
          />
        )}

        {shared && !shared.loading && shared.items.length > 0 && (
          <div className="poster-grid">
            {shared.items.map((item) => (
              <button
                type="button"
                className="poster-card"
                key={item.id}
                onClick={() => { onOpenTitle?.(item); setShared(null); }}
              >
                <Poster src={item.poster} alt={item.title} size="w342" />
                <span className="poster-card__cap truncate">{item.title}</span>
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/**
 * @param subtitle заменяет ник, когда есть что сказать важнее ника —
 *   например, сколько фильмов нравятся обоим.
 */
function PersonRow({ person, action, onOpen, subtitle }) {
  return (
    <div className="member">
      <button type="button" className="row gap-3 grow" style={{ minWidth: 0, textAlign: 'left' }} onClick={onOpen}>
        {person.photoURL
          ? <img className="member__avatar" src={person.photoURL} alt="" />
          : <span className="member__avatar member__avatar--empty">{initials(person.displayName)}</span>}
        <span className="stack grow" style={{ minWidth: 0 }}>
          <span className="member__name truncate">{person.displayName}</span>
          <span className="member__state truncate">
            {subtitle ?? `@${person.username}`}
          </span>
        </span>
      </button>
      {action}
    </div>
  );
}

const initials = (name) => String(name ?? '?').trim().split(/\s+/).slice(0, 2)
  .map((p) => p[0] ?? '').join('').toUpperCase() || '?';
