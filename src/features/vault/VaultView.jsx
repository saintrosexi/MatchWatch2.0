import { useMemo, useState } from 'react';
import { Bookmark, Check, Eye, Flame, Heart, Plus, Star, Trash2, Users } from '../../ui/icons.js';
import { RatingBadge } from '../../ui/RatingPicker.jsx';
import { EmptyState } from '../../ui/States.jsx';
import { Poster } from '../../ui/Poster.jsx';

/**
 * «Моё» — всё, про что решение уже принято.
 *
 * Списков три, по трём решениям. Дизлайков среди них нет намеренно:
 * их единственное назначение — исчезнуть из выбора, показывать такой
 * список незачем.
 */
const TABS = [
  { key: 'wishlist', label: 'Буду смотреть', icon: Bookmark },
  { key: 'watched', label: 'Просмотрено', icon: Eye },
  { key: 'ratings', label: 'Оценки', icon: Star },
  { key: 'favorites', label: 'Нравится', icon: Heart },
  { key: 'matches', label: 'Мэтчи', icon: Check },
  { key: 'room', label: 'Комната', icon: Users },
];

export function VaultView({
  room, favorites = {}, watched = {}, wishlist = {}, ratings = {}, matches = {},
  onOpenTitle, onRemoveFavorite, onUndoDecision, onOpenDeck, onOpenRooms,
  embedded = false,
}) {
  const [tab, setTab] = useState('wishlist');

  const roomItems = useMemo(() => room?.watchlist ?? [], [room?.watchlist]);
  const sorted = (map, key) => Object.values(map).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));

  const watchedItems = useMemo(() => sorted(watched, 'at'), [watched]);
  const wishItems = useMemo(() => sorted(wishlist, 'at'), [wishlist]);
  const favoriteItems = useMemo(() => sorted(favorites, 'addedAt'), [favorites]);
  // Оценённое сортируем по баллу: интересно, что понравилось больше всего.
  const ratedItems = useMemo(
    () => Object.values(ratings).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)),
    [ratings],
  );
  const matchItems = useMemo(() => sorted(matches, 'at'), [matches]);

  return (
    <div className="view">
      {!embedded && (
        <header className="view__head">
          <h1 className="view__title">Моё</h1>
          <p className="view__sub">Всё, что вы отсмотрели, отложили и на чём совпали.</p>
        </header>
      )}

      <div className="scroll-x" role="tablist">
        {TABS.map(({ key, label, icon: Icon }) => {
          const count = {
            wishlist: wishItems.length,
            watched: watchedItems.length,
            ratings: ratedItems.length,
            favorites: favoriteItems.length,
            matches: matchItems.length,
            room: roomItems.length,
          }[key];
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`chip chip--interactive ${tab === key ? 'chip--on' : ''}`}
              onClick={() => setTab(key)}
            >
              <Icon size={12} /> {label}
              {count > 0 && <b className="chip__count">{count}</b>}
            </button>
          );
        })}
      </div>

      {tab === 'wishlist' && (
        <Grid
          items={wishItems}
          onOpenTitle={onOpenTitle}
          onRemove={onUndoDecision}
          removeLabel="Вернуть в выбор"
          empty={{
            icon: Bookmark,
            title: 'Список желаемого пуст',
            text: 'Свайп вправо кладёт фильм сюда — это всё, что вы хотите посмотреть.',
            action: onOpenDeck && (
              <button type="button" className="btn btn--primary" onClick={onOpenDeck}>
                <Flame size={16} /> Открыть ленту
              </button>
            ),
          }}
        />
      )}

      {tab === 'watched' && (
        <Grid
          items={watchedItems}
          onOpenTitle={onOpenTitle}
          onRemove={onUndoDecision}
          removeLabel="Вернуть в выбор"
          empty={{
            icon: Eye,
            title: 'Пока ничего не отмечено',
            text: 'Кнопка с глазом отмечает фильм просмотренным — он уходит из выбора и остаётся здесь.',
            action: onOpenDeck && (
              <button type="button" className="btn btn--primary" onClick={onOpenDeck}>
                <Flame size={16} /> Открыть ленту
              </button>
            ),
          }}
        />
      )}

      {tab === 'ratings' && (
        ratedItems.length === 0 ? (
          <EmptyState
            icon={Star}
            title="Оценок пока нет"
            text="Откройте карточку фильма и поставьте оценку — она влияет на ленту сильнее свайпа."
            action={onOpenDeck && (
              <button type="button" className="btn btn--primary" onClick={onOpenDeck}>
                <Flame size={16} /> Открыть ленту
              </button>
            )}
          />
        ) : (
          <div className="poster-grid">
            {ratedItems.map((item) => (
              <button
                type="button"
                className="poster-card"
                key={item.id}
                onClick={() => onOpenTitle?.(item)}
              >
                <Poster src={item.poster} alt={item.title} size="w342" />
                <span className="poster-card__cap truncate">{item.title}</span>
                <RatingBadge value={item.rating} className="poster-card__rating" />
              </button>
            ))}
          </div>
        )
      )}

      {tab === 'favorites' && (
        <Grid
          items={favoriteItems}
          onOpenTitle={onOpenTitle}
          onRemove={onRemoveFavorite}
          removeLabel="Убрать из понравившихся"
          empty={{
            icon: Heart,
            title: 'Пока ничего не понравилось',
            text: 'Сердечко кладёт фильм сюда и влияет на подборку заметно сильнее обычного свайпа.',
            action: onOpenDeck && (
              <button type="button" className="btn btn--primary" onClick={onOpenDeck}>
                <Flame size={16} /> Открыть ленту
              </button>
            ),
          }}
        />
      )}

      {tab === 'matches' && (
        matchItems.length === 0 ? (
          <EmptyState
            icon={Check}
            title="Мэтчей ещё не было"
            text="Позовите друга в комнату — при обоюдном «да» фильм появится здесь с датой."
            action={onOpenRooms && (
              <button type="button" className="btn btn--primary" onClick={onOpenRooms}>
                <Plus size={16} /> Создать комнату
              </button>
            )}
          />
        ) : (
          <div className="stack gap-2">
            {matchItems.map((item) => (
              <button
                type="button"
                className="match-row"
                key={`${item.titleId}-${item.roomCode ?? 'solo'}`}
                onClick={() => onOpenTitle?.(item)}
              >
                <Poster className="match-row__poster" src={item.poster} alt={item.title} size="w185" />
                <span className="stack grow gap-1" style={{ textAlign: 'left' }}>
                  <span style={{ fontWeight: 600 }}>{item.title}</span>
                  <span className="faint" style={{ fontSize: 'var(--t-small)' }}>
                    {new Date(item.at).toLocaleDateString('ru-RU')}
                    {item.roomCode ? ` · комната ${item.roomCode}` : ''}
                  </span>
                </span>
                <span className="chip chip--on">мэтч</span>
              </button>
            ))}
          </div>
        )
      )}

      {tab === 'room' && (
        roomItems.length === 0 ? (
          <EmptyState
            icon={Users}
            title={room?.code ? 'Список пока пуст' : 'Вы не в комнате'}
            text={room?.code
              ? 'Мэтчи попадают сюда автоматически. Свайпайте — и список наполнится.'
              : 'Создайте комнату или войдите по коду, чтобы вести общий список.'}
            action={room?.code
              ? onOpenDeck && (
                <button type="button" className="btn btn--primary" onClick={onOpenDeck}>
                  <Flame size={16} /> Открыть ленту
                </button>
              )
              : onOpenRooms && (
                <button type="button" className="btn btn--primary" onClick={onOpenRooms}>
                  <Plus size={16} /> Создать комнату
                </button>
              )}
          />
        ) : (
          <div className="stack gap-2">
            {roomItems.map((item) => (
              <div className="match-row" key={item.titleId}>
                <Poster className="match-row__poster" src={item.poster} alt={item.title} size="w185" />
                <span className="stack grow gap-1">
                  <span style={{ fontWeight: 600 }}>{item.title}</span>
                  <span className="faint" style={{ fontSize: 'var(--t-small)' }}>
                    {item.year ?? ''}{item.fromMatch ? ' · мэтч' : ''}{item.watched ? ' · посмотрели' : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="action action--sm"
                  aria-label={item.watched ? 'Вернуть в список' : 'Отметить просмотренным'}
                  onClick={() => room.markWatched(item.titleId, !item.watched)}
                >
                  {item.watched ? <Check size={16} color="var(--text-mid)" /> : <Eye size={16} />}
                </button>
                <button
                  type="button"
                  className="action action--sm"
                  aria-label="Убрать из списка"
                  onClick={() => room.removeFromWatchlist(item.titleId)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** Сетка постеров с необязательной кнопкой удаления. */
function Grid({ items, onOpenTitle, onRemove, removeLabel, empty }) {
  if (items.length === 0) return <EmptyState {...empty} />; // action приходит в `empty.action` от вызывающей вкладки

  return (
    <div className="poster-grid">
      {items.map((item) => (
        <button
          type="button"
          className="poster-card"
          key={item.id ?? item.titleId}
          onClick={() => onOpenTitle?.(item)}
        >
          <Poster src={item.poster} alt={item.title} size="w342" />
          <span className="poster-card__cap truncate">{item.title}</span>
          {onRemove && (
            <span
              className="poster-card__flag"
              role="button"
              tabIndex={0}
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(e) => { e.stopPropagation(); onRemove(item); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onRemove(item); } }}
            >
              <Trash2 size={12} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
