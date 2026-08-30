import { useCallback, useEffect, useRef, useState } from 'react';
import { SwipeCard } from './SwipeCard.jsx';
import { ActionBar } from './ActionBar.jsx';
import { useSwipeGesture } from '../../hooks/useSwipeGesture.js';
import { EmptyState, ErrorState, LoadingState } from '../../ui/States.jsx';
import { NearMatches } from '../rooms/NearMatches.jsx';
import { NextRound } from '../rooms/NextRound.jsx';
import { prefetchPosters } from '../../ui/Poster.jsx';
import { haptic } from '../../lib/telegram.js';
import { sfx, unlockAudio } from '../../lib/sound.js';
import { ACTION } from '../../engine/tasteProfile.js';
import { getConfig } from '../../engine/recommendationConfig.js';
import { trackError } from '../../lib/telemetry.js';
import { LEVEL, MODULE } from '../../../shared/telemetry/events.js';
import { Compass, PartyPopper, SlidersHorizontal, Users } from '../../ui/icons.js';
import { StarScale } from '../../ui/RatingPicker.jsx';

/**
 * Стопка карточек: жест, кнопки, клавиатура и предзагрузка постеров.
 *
 * Управление с клавиатуры сделано не «на всякий случай»: на десктопе
 * стрелками листать быстрее, чем таскать мышью.
 */
export function SwipeDeck({
  deck, onDecision, onOpenDetails, onOpenFilters, onRestart, onUndo, canUndo,
  /**
   * Проставить оценку сразу после «уже смотрел».
   *
   * Спрашиваем ровно здесь и больше нигде: это единственный момент,
   * когда человек сам сказал, что фильм видел, — и единственный, когда
   * вопрос «как вам?» не выглядит вопросом про постер.
   */
  onRate,
  /** Показывать ли предложение оценить (`prefs.ratePrompt`). */
  askToRate = true,
  /** «Никогда не показывать» — выключает предложение до настроек. */
  onNeverAskToRate,
  /** В комнате остаются только «нет» и «да» — личные пометки там лишние. */
  compact = false,
  /** Прогресс участников комнаты: { size, mine, slowest, byUser }. */
  roomProgress = null,
  roomMembers = null,
  nearMatches = [],
  onAgreeNear = null,
  onRefreshNear = null,
  emptyTitle = 'Колода закончилась',
  emptyText = 'Мы показали всё, что подходит под фильтры. Ослабьте их — и лента оживёт.',
  emptyArt = null,
}) {
  const { current, upcoming, loading, refilling, error, exhausted, progress, processed } = deck;
  const [busy, setBusy] = useState(false);
  /*
   * Карточка, про которую сейчас спрашиваем оценку.
   *
   * Держим саму запись, а не идентификатор: к моменту ответа фильм уже
   * ушёл из очереди, и достать его оттуда будет неоткуда.
   */
  const [rating, setRating] = useState(null);
  const lastEntry = useRef(null);

  /*
   * Решение принято — карточка уходит немедленно.
   *
   * Раньше здесь стояло `await onDecision(...)`, и следующая карточка
   * появлялась только после того, как запись доедет до базы: два
   * запроса по мобильной сети, полсекунды и больше. Всё это время
   * на месте колоды была пустота — ровно то, что читается как
   * подтормаживание на каждом свайпе.
   *
   * Ждать было незачем. Списки и профиль вкуса обновляются в том же
   * кадре, локально, а сама запись durableWrite при неудаче ложится
   * в очередь и повторяется. Ответ базы не сообщает интерфейсу ничего,
   * чего он уже не знает.
   */
  const commit = useCallback((action) => {
    if (!current || busy) return;
    setBusy(true);
    lastEntry.current = current;
    const decided = current;

    /*
     * Снимаем именно ту карточку, по которой приняли решение,
     * и сообщаем, чем оно было: по решениям вечера лента
     * подстраивается на ходу.
     */
    deck.advance(decided.id, action !== 'dislike');

    /*
     * Спрашиваем оценку после «уже смотрел» и после «нравится».
     *
     * Здесь, у карточки, а не списком в «Моё»: человек только что
     * вспомнил фильм, и это единственная секунда, когда оценка стоит
     * ему одного касания. Отложенная просьба «оцените накопленное»
     * стоит уже усилия, и её закрывают не глядя.
     *
     * У «нравится» вопрос задаётся условно — «уже смотрели?». Свайп
     * вправо не означает просмотра, и прямое «как вам?» собирало бы
     * оценки постеров: они попадают в профиль вкуса наравне с честными
     * и портят его тем сильнее, чем больше их накопится.
     *
     * Любое следующее решение просьбу снимает: она про тот фильм,
     * который сейчас улетел, и висеть над следующим ей нечего.
     */
    const asks = action === ACTION.WATCHED || action === ACTION.FAVORITE;
    setRating(asks && askToRate && onRate ? { entry: decided, action } : null);

    Promise.resolve()
      .then(() => onDecision(decided, action))
      .catch((error) => trackError('Решение по карточке не записалось', {
        module: MODULE.DECK, level: LEVEL.WARNING, error,
      }));
  }, [current, busy, onDecision, deck, askToRate, onRate]);

  /*
   * Блокировка держится не до ответа сети, а до появления следующей
   * карточки: она нужна только чтобы одно движение пальца не решило
   * судьбу двух фильмов сразу.
   */
  useEffect(() => { setBusy(false); }, [current?.id]);

  /*
   * Просьба живёт девять секунд и уходит сама.
   *
   * Без таймера она осталась бы висеть над следующей карточкой до
   * ответа — то есть превратилась бы из предложения в препятствие.
   * Девять секунд — это прочитать строку и попасть в звезду, не больше.
   */
  useEffect(() => {
    if (!rating) return undefined;
    const timer = setTimeout(() => setRating(null), 9000);
    return () => clearTimeout(timer);
  }, [rating]);

  const { cardRef, fling, bind } = useSwipeGesture({
    enabled: Boolean(current) && !busy,
    // В комнате личных пометок нет — там и вертикальных жестов быть не должно.
    verticalEnabled: !compact,
    // Тап по карточке открывает описание — отдельной кнопки для этого нет.
    onTap: () => onOpenDetails?.(current),
    onDecision: (decision) => {
      unlockAudio();
      /*
       * Четыре направления — четыре решения, те же, что на кнопках:
       * вправо «нравится», влево «мимо», вверх «уже смотрел»,
       * вниз «буду смотреть». Описание открывается тапом; раньше
       * его открывал свайп вверх, но жест, который ничего не решает,
       * занимал целое направление из четырёх.
       */
      if (decision === 'like') { haptic('success'); sfx.favorite(); commit(ACTION.FAVORITE); }
      else if (decision === 'watched') { haptic('medium'); sfx.tick(); commit(ACTION.WATCHED); }
      else if (decision === 'later') { haptic('medium'); sfx.like(); commit(ACTION.LATER); }
      else { haptic('light'); sfx.pass(); commit(ACTION.DISLIKE); }
    },
  });

  /*
   * Постеры следующих карточек грузим заранее — иначе они «проявляются».
   * Берём их из очереди, а не из отрисованной стопки: в стопке лежат
   * две карточки, а грузить вперёд имеет смысл дальше.
   */
  useEffect(() => {
    const count = getConfig().deck.posterPrefetch;
    prefetchPosters(deck.queue.slice(1, count + 1).map((e) => e.title.poster));
  }, [deck.queue]);

  /* Клавиатура: стрелки — свайп, F — «нравится», пробел — детали. */
  useEffect(() => {
    if (!current) return undefined;
    const onKey = (e) => {
      // Цель события не обязана быть элементом: клавиатурные события
      // приходят и от document, у которого нет matches.
      const target = e.target;
      if (typeof target?.matches === 'function'
        && target.matches('input, textarea, [contenteditable]')) return;
      /*
       * В комнате личных пометок нет — ни кнопок, ни клавиш.
       *
       * Кнопки там скрыты, а клавиши оставались живыми: нажатие
       * проходило, обработчик решения выходил раньше записи, и отметка
       * исчезала в никуда. Молча потерянное действие хуже недоступного.
       */
      const wish = () => {
        if (compact) return;
        haptic('medium'); sfx.like(); commit(ACTION.LATER);
      };
      const seen = () => {
        if (compact) return;
        haptic('medium'); sfx.tick(); commit(ACTION.WATCHED);
      };
      const map = {
        ArrowLeft: () => { haptic('light'); sfx.pass(); fling('left', 'pass'); },
        ArrowRight: () => { haptic('success'); sfx.favorite(); fling('right', 'like'); },
        ArrowUp: () => onOpenDetails?.(current),
        ' ': () => onOpenDetails?.(current),
        s: wish, ы: wish,
        w: seen, ц: seen,
        z: () => onUndo?.(), я: () => onUndo?.(),
      };
      const handler = map[e.key];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, fling, commit, onOpenDetails, onUndo, compact]);

  // Пока едет следующая пачка, финальный экран показывать нельзя:
  // колода не кончилась, просто очередь на секунду опустела.
  if ((loading || refilling) && !current) {
    return <LoadingState text={refilling ? 'Подбираем следующую пачку…' : 'Подбираем кино под ваш вкус…'} />;
  }

  if (error && !current) {
    return <ErrorState error={error} onRetry={deck.retry} module="deck.build" />;
  }

  if (!current) {
    /*
     * «Колода закончилась» имеет право появиться, только когда каталог
     * действительно кончился. Пустая очередь сама по себе означает лишь
     * то, что впереди идёт длинная полоса уже решённого: у человека
     * с сотнями отметок это обычное дело, и объявлять ему конец кино
     * посреди каталога — враньё.
     */
    /*
     * В комнате пустая очередь чаще всего значит «я закончил порцию,
     * остальные ещё нет». Показывать здесь загрузку было бы враньём:
     * ничего не грузится, идёт ожидание живых людей.
     */
    if (roomProgress?.size) {
      const waiting = Object.entries(roomProgress.byUser ?? {})
        .filter(([, done]) => done < roomProgress.size)
        .map(([uid, done]) => ({
          name: roomMembers?.find((m) => m.uid === uid)?.name ?? 'Участник',
          done,
        }));

      /*
       * Ветка одна на два состояния — ждём людей или собираем следующую
       * порцию, — и это намеренно.
       *
       * Раньше почти-совпадения показывались только пока кто-то ещё
       * свайпает. То есть исчезали ровно в тот момент, когда становились
       * нужнее всего: все прошли пачку, обсуждать больше нечего, и
       * человек смотрел на крутящийся кружок вместо готового ответа.
       */
      const everyoneDone = waiting.length === 0;

      return (
        <div className="stack gap-4">
          {/*
            * Два состояния выглядят по-разному, потому что это разные
            * вещи. Ждать живого человека — значит смотреть, кто сколько
            * прошёл, и тут уместен список. Ждать подборку — значит ждать
            * машину, и тут уместен честный срок: пауза в несколько секунд
            * без единого признака работы читается как зависание.
            */}
          {everyoneDone ? <NextRound /> : (
            <EmptyState
              icon={Users}
              title="Свою пачку вы прошли"
              text="Ждём остальных — как только все закончат, добавим ещё карточек."
              action={(
                <div className="stack gap-2" style={{ minWidth: 220 }}>
                  {waiting.map((person) => (
                    <div className="row row--between" key={person.name}>
                      <span className="member__name">{person.name}</span>
                      <span className="mono faint">{person.done} из {roomProgress.size}</span>
                    </div>
                  ))}
                </div>
              )}
            />
          )}

          {/*
            * Почти-совпадения показываем ровно здесь: человек и так
            * стоит без дела. Вклиниваться с этим в ленту нельзя —
            * посреди свайпов такой вопрос читается как давление.
            */}
          {onAgreeNear && (
            <NearMatches
              items={nearMatches}
              onAgree={onAgreeNear}
              onRefresh={onRefreshNear}
            />
          )}
        </div>
      );
    }

    if (!exhausted) {
      return <LoadingState text="Листаем каталог дальше — вы много чего уже видели…" />;
    }

    return (
      <EmptyState
        icon={exhausted ? PartyPopper : Compass}
        art={emptyArt}
        title={emptyTitle}
        text={emptyText}
        action={(
          <div className="row gap-3">
            {onOpenFilters && (
              <button type="button" className="btn btn--primary" onClick={onOpenFilters}>
                <SlidersHorizontal size={16} /> Изменить фильтры
              </button>
            )}
            {onRestart && (
              <button type="button" className="btn btn--ghost" onClick={onRestart}>
                Начать заново
              </button>
            )}
          </div>
        )}
      />
    );
  }

  return (
    <>
      <div className="deck">
        <div className="deck__stage">
          {[...upcoming].reverse().map((entry, index) => (
            <SwipeCard
              key={entry.id}
              entry={entry}
              depth={upcoming.length - index}
            />
          ))}
          <SwipeCard
            key={current.id}
            ref={cardRef}
            entry={current}
            isTop
            verticalHints={!compact}
            bind={bind}
            onOpenDetails={() => onOpenDetails?.(current)}
          />

          {rating && (
            <RateAsk
              entry={rating.entry}
              action={rating.action}
              onRate={(value) => { setRating(null); onRate(rating.entry.title, value); }}
              onSkip={() => setRating(null)}
              onNever={onNeverAskToRate && (() => { setRating(null); onNeverAskToRate(); })}
            />
          )}
        </div>
      </div>

      <div className="deck-progress">
        <span className="mono">{processed}</span>
        <div className="deck-progress__bar">
          <div className="deck-progress__fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
        <span className="mono">{deck.queue.length}</span>
      </div>

      <ActionBar
        disabled={busy}
        canUndo={canUndo}
        compact={compact}
        onUndo={onUndo}
        onPass={() => { haptic('light'); sfx.pass(); fling('left', 'pass'); }}
        onWish={() => { haptic('medium'); sfx.like(); commit(ACTION.LATER); }}
        onWatched={() => { haptic('medium'); sfx.tick(); commit(ACTION.WATCHED); }}
        onLike={() => { haptic('success'); sfx.favorite(); fling('right', 'like'); }}
      />
    </>
  );
}

/**
 * Просьба оценить фильм, который только что отметили просмотренным.
 *
 * Стоит у карточки, поверх низа колоды, а не тостом в углу: тост
 * читается как отчёт о выполненном действии («отметили»), и просьбу
 * внутри него не замечают. Здесь же взгляд ещё на карточке — просьба
 * попадает ровно туда, откуда человек не успел уйти.
 *
 * Зачем это движку. Свайп «уже смотрел» — слабый сигнал, вес 0,2:
 * посмотреть можно и по чужому совету, и от скуки, и «видел» ничего
 * не говорит о том, понравилось ли. Оценка весит вчетверо больше
 * избранного и, в отличие от любого свайпа, умеет быть отрицательной:
 * тройка уводит ленту от похожего, а не просто не приближает к нему.
 * Один жест превращает пустую отметку в самый сильный сигнал, какой
 * человек вообще может дать.
 *
 * Две кнопки отказа, а не одна. «Пропустить» — про этот фильм,
 * «никогда» — про саму просьбу: без второй мы спрашивали бы снова
 * и снова у того, кто уже ответил, и продукт выпрашивал бы данные.
 * Возвращается в настройках — раздражение проходит быстрее решения.
 */
function RateAsk({ entry, action, onRate, onSkip, onNever }) {
  /*
   * «Смотрел» — утверждение, «нравится» — предположение.
   *
   * После отметки о просмотре спрашивать «как вам» можно прямо: человек
   * сам сказал, что видел фильм. После свайпа вправо этого никто
   * не говорил, и вопрос обязан оставлять выход тому, кто не смотрел.
   */
  const watched = action === ACTION.WATCHED;

  return (
    <section className="rate-ask" role="dialog" aria-label="Оцените фильм">
      <p className="rate-ask__lead">
        {watched
          ? `Смотрели «${entry.title.title}» — как вам?`
          : `Уже смотрели «${entry.title.title}»?`}
      </p>

      <StarScale onRate={onRate} size={30} />

      <p className="rate-ask__hint faint">
        Оценка решает в ленте больше свайпа: выше шести — несём похожее,
        ниже — уводим от него.
      </p>

      <div className="row gap-2">
        <button type="button" className="btn btn--sm btn--ghost" onClick={onSkip}>
          {watched ? 'Пропустить' : 'Ещё нет'}
        </button>
        {onNever && (
          <button type="button" className="btn btn--sm btn--quiet" onClick={onNever}>
            Никогда не показывать
          </button>
        )}
      </div>
    </section>
  );
}
