import { useEffect, useLayoutEffect, useState } from 'react';
import { haptic } from '../lib/telegram.js';
import { loadLocal, saveLocal } from '../lib/storage.js';
import { trackMetric } from '../lib/telemetry.js';
import { METRIC } from '../../shared/telemetry/events.js';

/**
 * Подсказки поверх живого экрана — единственный вид обучения в продукте.
 *
 * Слайды перед входом были и удалены 31.08.2026. Они рассказывали всё
 * сразу и до того, как человек увидел экран: к третьему слайду половина
 * забывается, а до ленты — ради которой пришли — семь экранов пути.
 * Эти подсказки показывают то же самое, но по месту: вырез обводит
 * живой элемент, а текст рядом объясняет ровно его.
 *
 * Показываются один раз на экран. Возвращать их по кнопке незачем:
 * человек, который уже пользуется, ничего нового здесь не узнает,
 * а всплывающее окно посреди работы читается как ошибка.
 *
 * Механика общая, наборы шагов — свои у каждого экрана: см.
 * `DeckCoach` и `RoomsCoach`.
 *
 * Шаг: `{ key, target, title, text, rows, place }`, где `target` —
 * селектор живого элемента, а `place` — где встать подсказке
 * относительно него (`above` | `below` | `center`).
 */

export function Coach({ steps, seenKey, area, active = false, onDone }) {
  const [step, setStep] = useState(0);
  const [box, setBox] = useState(null);

  const current = steps[step];

  /*
   * Позицию берём перед кадром отрисовки: подсказка появляется уже
   * на месте, а не прыгает к цели на глазах.
   */
  useLayoutEffect(() => {
    if (!active || !current) return undefined;

    const measure = () => {
      const node = document.querySelector(current.target);
      setBox(node ? node.getBoundingClientRect() : null);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active, current]);

  useEffect(() => {
    if (!active) setStep(0);
  }, [active]);

  if (!active || !current) return null;

  const finish = () => {
    haptic('light');
    saveLocal(seenKey, true);
    /*
     * Шаг воронки переехал сюда со слайдов вместе с самим обучением.
     * Считается и «прошёл до конца», и «закрыл на середине»: для воронки
     * важно, что человек добрался до ленты и увидел подсказки, а сколько
     * из них он долистал — вопрос к подсказкам, а не к воронке.
     */
    trackMetric(METRIC.ONBOARDING_DONE, { context: { area, step: step + 1, of: steps.length } });
    onDone?.();
  };

  const next = () => {
    haptic('light');
    if (step >= steps.length - 1) { finish(); return; }
    setStep((i) => i + 1);
  };

  /*
   * Вырез вокруг цели — тенью на всю страницу, а не четырьмя блоками
   * по краям: одна тень дешевле в отрисовке и не оставляет швов
   * на скруглениях.
   */
  const holeStyle = box ? {
    top: box.top - 8,
    left: box.left - 8,
    width: box.width + 16,
    height: box.height + 16,
  } : null;

  /*
   * Горизонтальное центрирование задаётся здесь же, а не только в CSS:
   * inline-стиль перезаписывает свойство `transform` целиком, и центр
   * по вертикали затирал бы центр по горизонтали — карточка уезжала
   * за правый край.
   */
  const centered = { top: '50%', transform: 'translate(-50%, -50%)' };
  const tipStyle = box
    ? current.place === 'above'
      ? { bottom: `${Math.max(16, window.innerHeight - box.top + 16)}px` }
      : current.place === 'below'
        ? { top: `${box.bottom + 16}px` }
        : centered
    : centered;

  return (
    <div className="coach" role="dialog" aria-label={current.title}>
      {/*
        * Затемнение рисует ВЫРЕЗ, а не эта подложка: она только ловит
        * нажатия. Пока фон был и здесь, серым становилось всё, включая
        * то, на что подсказка показывает, — а показывать имеет смысл
        * только на что-то видимое.
        */}
      <button
        type="button"
        className={`coach__scrim ${box ? '' : 'coach__scrim--solid'}`}
        aria-label="Дальше"
        onClick={next}
      />
      {holeStyle && <span className="coach__hole" style={holeStyle} aria-hidden="true" />}

      <div className="coach__tip" style={tipStyle}>
        <h3 className="coach__title">{current.title}</h3>
        <p className="coach__text">{current.text}</p>

        {current.rows.length > 0 && (
          <ul className="coach__rows">
            {current.rows.map(({ icon: Icon, tone, label }) => (
              <li key={label} className={`coach__row coach__row--${tone}`}>
                <Icon size={14} weight={tone === 'like' || tone === 'wish' ? 'fill' : 'regular'} />
                {label}
              </li>
            ))}
          </ul>
        )}

        <div className="coach__foot">
          <span className="coach__dots" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={s.key} className={i === step ? 'coach__dot coach__dot--on' : 'coach__dot'} />
            ))}
          </span>
          <div className="row gap-2">
            <button type="button" className="btn btn--quiet btn--sm" onClick={finish}>Пропустить</button>
            <button type="button" className="btn btn--primary btn--sm" onClick={next}>
              {step >= steps.length - 1 ? 'Понятно' : 'Дальше'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Видел ли человек эти подсказки. Проверяется до показа экрана. */
export const coachSeen = (seenKey) => Boolean(loadLocal(seenKey, false));
