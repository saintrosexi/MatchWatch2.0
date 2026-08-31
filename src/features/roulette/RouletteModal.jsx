import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dices, Play, Star } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Poster } from '../../ui/Poster.jsx';
import { haptic } from '../../lib/telegram.js';
import { sfx, unlockAudio } from '../../lib/sound.js';
import { trackMetric } from '../../lib/telemetry.js';
import { METRIC } from '../../../shared/telemetry/events.js';
import { pickReel, rouletteCandidates, RECENT_MEMORY } from '../../engine/roulette.js';
import { loadLocal, saveLocal, STORAGE_KEYS } from '../../lib/storage.js';

/** Сколько полных оборотов проходит лента до остановки. */
const LOOPS = 3;
const SPIN_MS = 2800;

/**
 * Кино-рулетка.
 *
 * Берёт десять фильмов из рекомендаций, прокручивает их и останавливается
 * на десятом — лучшем по качеству. Исход предрешён с самого начала, и это
 * намеренно: рулетка здесь не про случайность выбора, а про то, чтобы
 * снять с человека необходимость решать. Случаен состав, а не победитель.
 */
export function RouletteModal({ open, onClose, getPool, onPick, history = {}, taste = null }) {
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState(null);
  /* Счётчик прокруток: им пересобирается барабан, не трогая остальное. */
  const [round, setRound] = useState(0);
  /* Барабан пересобран и ждёт отрисовки — крутить можно только после неё. */
  const [pendingSpin, setPendingSpin] = useState(false);
  const timers = useRef([]);
  const stripRef = useRef(null);
  const animation = useRef(null);

  /*
   * Каталог читаем в момент открытия, а не на каждом рендере: он живёт
   * в ref колоды и растёт по мере подгрузки.
   */
  const candidates = useMemo(
    () => (open ? rouletteCandidates(getPool?.() ?? [], history) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, history],
  );

  /* Что уже выпадало: рулетка не должна повторяться два раза подряд. */
  const recent = useMemo(
    () => (open ? loadLocal(STORAGE_KEYS.ROULETTE_RECENT, []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, round],
  );

  /*
   * Барабан набирается из близкого вкусу, а внутри десятки случайность
   * честная — включая того, кто выпадет. `round` в зависимостях: без него
   * «Ещё раз» крутило бы ровно тот же барабан.
   */
  const reel = useMemo(
    () => pickReel(candidates, { taste, recent }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, taste, round],
  );

  const winner = reel[reel.length - 1] ?? null;

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const stopAnimation = () => { animation.current?.cancel(); animation.current = null; };

  useEffect(() => () => { clearTimers(); stopAnimation(); }, []);

  useEffect(() => {
    if (!open) {
      clearTimers(); stopAnimation();
      setSpinning(false); setResult(null); setPendingSpin(false);
    }
  }, [open]);

  const spin = useCallback(() => {
    if (spinning || reel.length < 2) return;
    unlockAudio();
    clearTimers();
    stopAnimation();
    setResult(null);
    setSpinning(true);
    trackMetric(METRIC.ROULETTE_SPIN, { context: { poolSize: candidates.length } });

    /*
     * Анимируем ленту напрямую, а не через состояние React: перерисовка
     * между «сбросить в ноль» и «уехать в конец» происходит в неизвестный
     * момент, и переход то запускался, то нет. Web Animations API даёт
     * гарантию — кадры считает браузер, а не порядок рендеров.
     */
    const node = stripRef.current;
    const cellHeight = node?.firstElementChild?.getBoundingClientRect().height ?? 0;
    const target = reel.length * LOOPS + (reel.length - 1);

    if (node && cellHeight > 0) {
      animation.current = node.animate(
        [{ transform: 'translateY(0)' }, { transform: `translateY(-${target * cellHeight}px)` }],
        { duration: SPIN_MS, easing: 'cubic-bezier(0.12, 0.72, 0.12, 1)', fill: 'forwards' },
      );
    }

    const ticker = setInterval(() => { sfx.reel(); haptic('soft'); }, 170);
    timers.current.push(setTimeout(() => clearInterval(ticker), SPIN_MS - 250));

    timers.current.push(setTimeout(() => {
      setSpinning(false);
      setResult(winner);
      haptic('success');
      sfx.favorite();

      /*
       * Запоминаем весь барабан, а не одного победителя.
       *
       * Человек видел все десять постеров, пока лента крутилась, —
       * для него повторится и не выигравший. Помним ограниченный хвост:
       * длинная память у человека с узким вкусом съела бы всю полосу.
       */
      const shown = [...reel.map((t) => t.id), ...recent].slice(0, RECENT_MEMORY);
      saveLocal(STORAGE_KEYS.ROULETTE_RECENT, [...new Set(shown)]);
    }, SPIN_MS));
  }, [spinning, reel, winner, recent, candidates.length]);

  /*
   * Прокрутка в два шага: сперва новый барабан, потом вращение.
   *
   * Одним действием не выходит. Барабан живёт в разметке, и анимация
   * меряет высоту уже отрисованных ячеек — крутить состав, которого
   * на экране ещё нет, нечем. Поэтому нажатие только заказывает новый
   * барабан, а вращение запускает эффект, когда тот отрисовался.
   *
   * Подмена состава не видна: к этому моменту лента уже отброшена
   * в начало, а результат прошлой прокрутки убран.
   */
  const requestSpin = useCallback(() => {
    if (spinning) return;
    clearTimers();
    stopAnimation();
    setResult(null);
    setRound((n) => n + 1);
    setPendingSpin(true);
  }, [spinning]);

  useEffect(() => {
    if (!pendingSpin) return;
    setPendingSpin(false);
    spin();
    // `reel` в зависимостях — это и есть ожидание нового барабана.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSpin, reel]);

  /*
   * Закрытие обязано быть безотказным. Здесь уже жила опечатка от прошлой
   * реализации — вызов исчезнувшего сеттера ронял обработчик до onClose(),
   * и крестик переставал работать. Поэтому уборка обёрнута в try, а
   * onClose() стоит так, чтобы выполниться при любом исходе.
   */
  const close = useCallback(() => {
    try {
      clearTimers();
      stopAnimation();
      setSpinning(false);
      setResult(null);
      setPendingSpin(false);
    } finally {
      onClose?.();
    }
  }, [onClose]);

  // Лента повторяется, чтобы прокрутка выглядела бесконечной.
  const strip = useMemo(
    () => Array.from({ length: LOOPS + 1 }, () => reel).flat(),
    [reel],
  );

  return (
    <Sheet open={open} onClose={close} title="Кино-рулетка" variant="center">
      <div className="roulette">
        <p className="state__text">
          {result
            ? 'Лучший из десяти — смотрим его.'
            : 'Возьмём десять фильмов из ваших рекомендаций и выберем за вас.'}
        </p>

        <div className="reel">
          <div className="reel__strip" ref={stripRef}>
            {strip.map((movie, i) => (
              <div className="reel__cell" key={`${movie.id}-${i}`}>
                <Poster src={movie.poster} alt={movie.title} size="w342" eager={i < 4} />
              </div>
            ))}
          </div>
          <div className="reel__frame" />
        </div>

        {result && (
          <div className="stack gap-2" style={{ textAlign: 'center', alignItems: 'center' }}>
            <h3 style={{ fontSize: 'var(--t-title)' }}>{result.title}</h3>
            <div className="row gap-2">
              {result.rating > 0 && (
                <span className="badge badge--rating">
                  <Star size={12} weight="fill" /> {result.rating.toFixed(1)}
                </span>
              )}
              {result.year && <span className="chip">{result.year}</span>}
              {result.genres?.[0] && <span className="chip">{result.genres[0]}</span>}
            </div>
          </div>
        )}

        <div className="row gap-3">
          <button
            type="button"
            className="btn btn--gold btn--lg"
            onClick={requestSpin}
            disabled={spinning || reel.length < 2}
          >
            <Dices size={20} /> {result ? 'Ещё раз' : 'Крутить'}
          </button>
          {result && (
            <button type="button" className="btn btn--primary btn--lg" onClick={() => { onPick?.(result); close(); }}>
              <Play size={20} /> Открыть
            </button>
          )}
        </div>

        {candidates.length < 2 && (
          <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
            Нечего крутить: сначала откройте ленту, чтобы подтянулись рекомендации.
          </p>
        )}
      </div>
    </Sheet>
  );
}
