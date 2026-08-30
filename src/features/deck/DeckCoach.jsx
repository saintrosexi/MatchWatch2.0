import { useEffect, useLayoutEffect, useState } from 'react';
import { Bookmark, Dices, Eye, Flame, Heart, RotateCcw, SlidersHorizontal, X } from '../../ui/icons.js';
import { haptic } from '../../lib/telegram.js';
import { loadLocal, saveLocal } from '../../lib/storage.js';
import { trackMetric } from '../../lib/telemetry.js';
import { METRIC } from '../../../shared/telemetry/events.js';

const SEEN_KEY = 'coach:deck';

/**
 * Подсказки поверх ленты — единственное обучение в продукте.
 *
 * Слайды перед входом были и удалены 31.08.2026. Они рассказывали всё
 * сразу и до того, как человек увидел экран: к третьему слайду половина
 * забывается, а до ленты — ради которой пришли — семь экранов пути.
 * Эти подсказки показывают то же самое, но по месту: стрелка указывает
 * на живой элемент, а текст рядом объясняет ровно его.
 *
 * Показываются один раз. Возвращать их по кнопке незачем: человек,
 * который уже свайпает, ничего нового здесь не узнает, а всплывающее
 * окно посреди ленты читается как ошибка.
 */
const STEPS = [
  {
    key: 'gestures',
    target: '.card--top',
    title: 'Тащите карточку',
    text: 'В любую из четырёх сторон — куда утащили, то и решили. Тап открывает описание.',
    rows: [
      { icon: Heart, tone: 'like', label: 'вправо — нравится' },
      { icon: X, tone: 'pass', label: 'влево — мимо' },
      { icon: Eye, tone: 'seen', label: 'вверх — уже смотрел' },
      { icon: Bookmark, tone: 'wish', label: 'вниз — буду смотреть' },
    ],
    place: 'center',
  },
  {
    key: 'mode',
    target: '.feed-switch',
    title: 'Настроение ленты',
    text: '«Моё» — похожее на любимое. «Другое» — незнакомое, и лента сразу идёт за тем, что вы лайкнули в этот заход.',
    rows: [{ icon: Flame, tone: 'info', label: 'при следующем заходе снова «Моё»' }],
    place: 'below',
  },
  {
    key: 'actions',
    target: '.actions',
    title: 'Те же решения кнопками',
    text: 'Если свайпать неудобно — под колодой те же четыре решения, слева направо.',
    rows: [
      { icon: RotateCcw, tone: 'muted', label: 'вернуть: отменить последнее решение и получить тот фильм обратно' },
      { icon: X, tone: 'pass', label: 'мимо' },
      { icon: Bookmark, tone: 'wish', label: 'буду смотреть' },
      { icon: Eye, tone: 'seen', label: 'уже смотрел' },
      { icon: Heart, tone: 'like', label: 'нравится' },
    ],
    place: 'above',
  },
  {
    key: 'tools',
    target: '[data-coach="tools"]',
    title: 'Кубик и фильтры',
    text: 'Кубик достаёт случайный фильм из тех, что вам подходят, — когда решать не хочется вовсе. Фильтры сужают ленту: жанры, годы, рейтинг, страна.',
    /* Якорь одинаков в телефонном и десктопном шеллах — см. `data-coach`. */
    rows: [
      { icon: Dices, tone: 'info', label: 'кубик — случайный фильм' },
      { icon: SlidersHorizontal, tone: 'info', label: 'ползунки — фильтры ленты' },
    ],
    place: 'below',
  },
];

export function DeckCoach({ active = false, onDone }) {
  const [step, setStep] = useState(0);
  const [box, setBox] = useState(null);

  const current = STEPS[step];

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
    saveLocal(SEEN_KEY, true);
    /*
     * Шаг воронки переехал сюда со слайдов вместе с самим обучением.
     * Считается и «прошёл до конца», и «закрыл на середине»: для воронки
     * важно, что человек добрался до ленты и увидел подсказки, а сколько
     * из них он долистал — вопрос к подсказкам, а не к воронке.
     */
    trackMetric(METRIC.ONBOARDING_DONE, { context: { step: step + 1, of: STEPS.length } });
    onDone?.();
  };

  const next = () => {
    haptic('light');
    if (step >= STEPS.length - 1) { finish(); return; }
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
            {STEPS.map((s, i) => (
              <i key={s.key} className={i === step ? 'coach__dot coach__dot--on' : 'coach__dot'} />
            ))}
          </span>
          <div className="row gap-2">
            <button type="button" className="btn btn--quiet btn--sm" onClick={finish}>Пропустить</button>
            <button type="button" className="btn btn--primary btn--sm" onClick={next}>
              {step >= STEPS.length - 1 ? 'Понятно' : 'Дальше'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Видел ли человек подсказки. Проверяется до показа ленты. */
export const coachSeen = () => Boolean(loadLocal(SEEN_KEY, false));
