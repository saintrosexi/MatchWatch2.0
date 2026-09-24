import { forwardRef } from 'react';
import { Clock, Compass, Heart, Sparkles, Star } from '../../ui/icons.js';
import { Poster } from '../../ui/Poster.jsx';
import { tagLabel } from '../../../shared/taxonomy/tagOntology.js';

const RUNTIME = (minutes) => (minutes ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : null);

/**
 * Карточка фильма.
 *
 * Показывает не только «что», но и «почему»: подсвеченные теги — те,
 * что совпали с накопленным профилем. Разведочная карточка помечается
 * честно, чтобы неожиданная рекомендация не выглядела ошибкой алгоритма.
 */
export const SwipeCard = forwardRef(function SwipeCard(
  { entry, depth = 0, isTop = false, bind, onOpenDetails, verticalHints = true },
  ref,
) {
  const { title, matchedTags = [], slot, confidence, becauseOf, alsoFor } = entry;
  const explore = slot === 'explore';

  return (
    <article
      ref={ref}
      className={`card ${isTop ? 'card--top' : ''}`}
      data-depth={isTop ? undefined : depth}
      aria-label={`${title.title}${title.year ? `, ${title.year}` : ''}. Нажмите, чтобы открыть описание`}
      role={isTop ? 'button' : undefined}
      tabIndex={isTop ? 0 : undefined}
      onKeyDown={isTop ? (e) => {
        if (e.key === 'Enter') onOpenDetails?.();
      } : undefined}
      {...(isTop ? bind : {})}
    >
      {title.poster ? (
        <Poster className="card__poster" src={title.poster} alt={title.title} eager={depth < 2} />
      ) : (
        <div className="card__fallback">
          <h3 className="card__fallback-title">{title.title}</h3>
          {title.year && <span className="muted">{title.year}</span>}
        </div>
      )}

      <div className="card__shade" />

      {isTop && (
        <>
          <div className="card__stamp card__stamp--yes" aria-hidden="true">
            <Heart size={26} weight="fill" />
          </div>
          <div className="card__stamp card__stamp--no" aria-hidden="true">НЕТ</div>
          {/* Вертикальные жесты — личные пометки: вверх «уже смотрел»,
              вниз «отложить». В комнате их нет, поэтому и штампов нет. */}
          {verticalHints && (
            <>
              <div className="card__stamp card__stamp--seen" aria-hidden="true">СМОТРЕЛ</div>
              <div className="card__stamp card__stamp--later" aria-hidden="true">БУДУ СМОТРЕТЬ</div>
            </>
          )}
        </>
      )}

      <div className="card__body">
        <div className="card__meta">
          {title.rating > 0 && (
            <span className="badge badge--rating">
              <Star size={12} weight="fill" /> {title.rating.toFixed(1)}
            </span>
          )}
          {title.year && <span className="muted" style={{ fontSize: 'var(--t-small)' }}>{title.year}</span>}
          {title.runtime && (
            <span className="muted row gap-1" style={{ fontSize: 'var(--t-small)' }}>
              <Clock size={12} /> {RUNTIME(title.runtime)}
            </span>
          )}
          {explore && (
            <span className="chip" style={{ padding: '2px 8px', fontSize: 'var(--t-micro)' }}>
              <Compass size={12} /> разведка
            </span>
          )}
          {!explore && confidence === 'strong' && (
            <span className="chip chip--on" style={{ padding: '2px 8px', fontSize: 'var(--t-micro)' }}>
              <Sparkles size={12} /> в точку
            </span>
          )}
        </div>

        <h2 className="card__title">{title.title}</h2>

        <div className="card__tags">
          {topTags(title, matchedTags).map(({ tag, hit }) => (
            <span key={tag} className={`card__tag ${hit ? 'card__tag--hit' : ''}`}>
              {tagLabel(tag)}
            </span>
          ))}
        </div>

        {isTop && (
          <p className="card__why">
            {/*
              * Конкретный фильм вместо перечня тем.
              *
              * «Похоже на "Брата", который вам зашёл» человек проверяет
              * сам за секунду: он помнит «Брата» и знает, похоже ли.
              * «Совпало по темам: криминал, одиночка» проверить нечем —
              * это отчёт о работе движка, а не довод.
              *
              * Темы остаются запасным вариантом: у карточек без опоры
              * сказать больше нечего.
              */}
            {explore
              ? <>Показываем, чтобы расширить ваш вкус — тема для вас новая</>
              : becauseOf?.title
                ? <>Похоже на <strong>«{becauseOf.title}»</strong> из ваших любимых</>
                : matchedTags.length
                  ? <>Похоже на то, что вы любите: <strong>{matchedTags.slice(0, 2).map(tagLabel).join(', ')}</strong></>
                  /*
                   * Запасная строка обязана быть правдой.
                   *
                   * Раньше здесь стояло «высокий рейтинг у зрителей» —
                   * без всякой оглядки на сам рейтинг. Она появлялась
                   * и над фильмом с оценкой 6.8, и человек видел, что
                   * приложение ему врёт. Одно такое место обесценивает
                   * все остальные объяснения, даже честные.
                   */
                  : (title.rating ?? 0) >= 7.5
                    ? <>Оценка <strong>{title.rating.toFixed(1)}</strong> — зрители хвалят</>
                    : <>Пока присматриваемся к вашему вкусу — скажите «да» или «мимо»</>}
          </p>
        )}

        {/*
          * Вторая строка — про того, с кем смотрите.
          *
          * Вечер вдвоём разваливается не на вопросе «нравится ли мне»,
          * а на вопросе «а ей зайдёт?». Ответ у подбора есть — фильм
          * и попал сюда потому, что близок обоим, — но до сих пор он
          * оставался внутри расчёта, и человек решал вслепую.
          *
          * С именем, а не «вашему партнёру»: в комнате сидят знакомые
          * люди, и «Соня» говорит больше, чем любая формулировка.
          *
          * Появляется только когда близость выше порога. Строка ценна
          * ровно тем, что ей можно верить; под каждой карточкой подряд
          * она стала бы шумом и обесценила заодно и первую.
          */}
        {isTop && alsoFor?.title && (
          <p className="card__why card__why--partner">
            <strong>{alsoFor.name}</strong> — похоже на <strong>«{alsoFor.title}»</strong> из любимых
          </p>
        )}

        {isTop && (
          <p className="card__hint">Нажмите на карточку — описание, актёры, трейлер</p>
        )}
      </div>
    </article>
  );
});

/** Совпавшие теги идут первыми — они объясняют выдачу. */
function topTags(title, matchedTags, limit = 5) {
  const matched = new Set(matchedTags);
  const rest = Object.entries(title.tags ?? {})
    .filter(([tag]) => !matched.has(tag))
    .sort(([, a], [, b]) => b - a)
    .map(([tag]) => tag);

  return [
    ...matchedTags.map((tag) => ({ tag, hit: true })),
    ...rest.map((tag) => ({ tag, hit: false })),
  ].slice(0, limit);
}
