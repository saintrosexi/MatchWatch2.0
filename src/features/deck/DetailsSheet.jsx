import { useEffect, useState } from 'react';
import {
  Bookmark, BookmarkX, Eye, EyeOff, Heart, HeartOff, Loader2, Play, Sparkles, Star, Users, ICON,
} from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Poster } from '../../ui/Poster.jsx';
import { MoodBars } from '../../ui/Radar.jsx';
import { RatingPicker } from '../../ui/RatingPicker.jsx';
import { api, describeError } from '../../lib/api.js';
import { openLink } from '../../lib/telegram.js';
import { tagLabel } from '../../../shared/taxonomy/tagOntology.js';
import { parseTitleId } from '../../../shared/model/title.js';
import { withPlural, FORMS } from '../../../shared/i18n/plural.js';

/**
 * Карточка деталей. Подтягивает полные данные (описание, актёры, трейлер),
 * если тайтл пришёл «лёгким» из списка каталога.
 */
export function DetailsSheet({
  open, entry, onClose, onOpenActor, onToggleWatched, isWatched,
  onToggleLike, isLiked = false, onToggleWish, isWished = false,
  rating = null, onRate,
  /** Чего хотели сегодня — если запрос был. Попадает в объяснение. */
  wanted = null,
}) {
  const [full, setFull] = useState(entry?.title ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !entry) return undefined;
    setFull(entry.title);

    if (entry.title?.overview && entry.title?.cast?.length) return undefined;

    const externalId = Number(parseTitleId(entry.title.id)?.externalId);
    if (!Number.isFinite(externalId)) return undefined;

    let cancelled = false;
    setLoading(true);
    api.title(externalId)
      .then((payload) => { if (!cancelled && payload?.title) setFull(payload.title); })
      .catch(() => { /* остаёмся на том, что есть */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, entry]);

  if (!entry) return null;
  const title = full ?? entry.title;

  return (
    <Sheet open={open} onClose={onClose} title={title.title}>
      <div className="details__body">
        {title.backdrop && (
          <div className="details__hero">
            <Poster className="details__backdrop" src={title.backdrop} size="w780" alt="" rounded={false} />
            <div className="details__backdrop-shade" />
          </div>
        )}

        <div className="details__meta">
          {title.rating > 0 && (
            <span className="badge badge--rating">
              <Star size={12} weight="fill" /> {title.rating.toFixed(1)}
              {title.votes ? <span className="faint"> · {formatVotes(title.votes)}</span> : null}
            </span>
          )}
          {title.year && <span className="chip">{title.year}</span>}
          {title.runtime && <span className="chip">{Math.floor(title.runtime / 60)} ч {title.runtime % 60} мин</span>}
          {(title.genres ?? []).slice(0, 3).map((g) => <span key={g} className="chip">{g}</span>)}
          {title.collection && (
            <span className="chip" title="Часть франшизы">
              {title.collection.name.replace(/\s*\(Коллекция\)\s*/i, '')}
            </span>
          )}
        </div>

        {title.tagline && <p className="muted" style={{ fontStyle: 'italic' }}>«{String(title.tagline).replace(/^[«"„“]+|[»"“”]+$/g, '')}»</p>}

        {onRate && (
          <section className="section surface" style={{ padding: 'var(--s-4)' }}>
            <span className="eyebrow">Ваша оценка</span>
            <RatingPicker value={rating} onRate={(value) => onRate(title, value)} />
          </section>
        )}

        <p className="details__overview">
          {title.overview ?? (loading ? 'Загружаем описание…' : 'Описание пока не добавлено в TMDB.')}
        </p>

        <WhyThisFilm entry={entry} title={title} wanted={wanted} />

        {Object.keys(title.tags ?? {}).length > 0 && (
          <section className="section">
            <span className="eyebrow">Темы и поджанры</span>
            <div className="tag-cloud">
              {Object.entries(title.tags)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 12)
                .map(([tag, weight]) => (
                  <span
                    key={tag}
                    className={`tag-cloud__item ${entry.matchedTags?.includes(tag) ? 'chip--on' : ''}`}
                  >
                    {tagLabel(tag)} <b>{weight}</b>
                  </span>
                ))}
            </div>
          </section>
        )}

        {title.moods && (
          <section className="section">
            <span className="eyebrow">Настроение фильма</span>
            <MoodBars vector={title.moods} />
          </section>
        )}

        {title.directors?.length > 0 && (
          <p className="muted" style={{ fontSize: 'var(--t-small)' }}>
            Режиссёр: {title.directors.map((d) => d.name).join(', ')}
          </p>
        )}

        {title.cast?.length > 0 && (
          <section className="section">
            <span className="eyebrow"><Users size={12} style={{ verticalAlign: -2 }} /> В ролях</span>
            <div className="cast-strip">
              {title.cast.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className="cast"
                  onClick={() => onOpenActor?.(person.id)}
                  title={`Открыть профиль: ${person.name}`}
                >
                  {person.photo
                    ? <img className="cast__photo" src={person.photo} alt="" loading="lazy" />
                    : <div className="cast__photo" />}
                  <span className="cast__name">{person.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="row gap-3" style={{ flexWrap: 'wrap' }}>
          {title.trailerKey && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => openLink(`https://www.youtube.com/watch?v=${title.trailerKey}`)}
            >
              <Play size={16} /> Трейлер
            </button>
          )}
          {/*
            * Решение о фильме принимается и отсюда, а не только свайпом:
            * в каталог и к актёру человек приходит целенаправленно, и
            * возвращать его в ленту ради одной отметки — лишний круг.
            */}
          {onToggleLike && (
            <button
              type="button"
              className={`btn ${isLiked ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => onToggleLike(title)}
            >
              {isLiked
                ? <><HeartOff size={16} /> Убрать «нравится»</>
                : <><Heart size={16} weight="fill" /> Нравится</>}
            </button>
          )}
          {onToggleWish && (
            <button type="button" className="btn btn--ghost" onClick={() => onToggleWish(title)}>
              {isWished
                ? <><BookmarkX size={16} /> Убрать из «буду смотреть»</>
                : <><Bookmark size={16} /> Буду смотреть</>}
            </button>
          )}
          {onToggleWatched && (
            <button type="button" className="btn btn--ghost" onClick={() => onToggleWatched(title)}>
              {isWatched ? <><EyeOff size={16} /> Убрать «просмотрено»</> : <><Eye size={16} /> Просмотрено</>}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

const formatVotes = (votes) =>
  (votes >= 1000
    ? `${Math.round(votes / 100) / 10} тыс. оценок`
    : withPlural(votes, FORMS.RATING));

/**
 * «Почему этот фильм».
 *
 * По кнопке, а не сразу: объяснение стоит обращения к модели, а
 * спрашивают о нём редко — обычно и так понятно. Греть на этом каждую
 * открытую карточку было бы тратой без спроса.
 *
 * Наружу уходят только подписи тем и то, чего хотели сегодня. Ни истории
 * решений, ни профиля целиком: объяснение не стоит того, чтобы отдавать
 * вкус человека стороннему сервису.
 */
function WhyThisFilm({ entry, title, wanted }) {
  const [state, setState] = useState({ status: 'idle', text: null });

  const matched = entry?.matchedTags ?? [];
  const topTags = Object.entries(title?.tags ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([tag]) => tagLabel(tag));

  // Объяснять нечего, пока не на чем: без тем модель начнёт сочинять.
  if (!topTags.length) return null;

  const ask = async () => {
    setState({ status: 'loading', text: null });
    try {
      const { reason } = await api.aiExplain({
        title: title.title,
        year: title.year ?? null,
        sharedTags: matched.map(tagLabel),
        titleTags: topTags,
        wanted: wanted ?? '',
        confidence: entry?.confidence ?? null,
      });
      setState({ status: 'done', text: reason });
    } catch (error) {
      if (error?.code === 'ai_not_configured') {
        setState({ status: 'off', text: null });
        return;
      }
      setState({ status: 'error', text: describeError(error).text });
    }
  };

  if (state.status === 'off') return null;

  if (state.status === 'done') {
    return (
      <p className="why-film">
        <Sparkles size={ICON.sm} className="why-film__icon" /> {state.text}
      </p>
    );
  }

  return (
    <div className="why-film">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={ask}
        disabled={state.status === 'loading'}
      >
        {state.status === 'loading'
          ? <><Loader2 size={ICON.sm} className="spin" /> Думаем…</>
          : <><Sparkles size={ICON.sm} /> Почему этот фильм?</>}
      </button>
      {state.status === 'error' && (
        <span className="why-film__error">{state.text}</span>
      )}
    </div>
  );
}
