import {
  Bookmark, Dices, Eye, Flame, Heart, PartyPopper, RotateCcw, SlidersHorizontal, Users, X,
} from '../../ui/icons.js';
import { Coach, coachSeen } from '../../ui/Coach.jsx';

const SEEN_KEY = 'coach:deck';

/**
 * Обучение на ленте: четыре шага про саму колоду и пятый — про то,
 * ради чего продукт существует. Механика общая, см. `ui/Coach.jsx`.
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
  {
    /*
     * Последний шаг — про то, ради чего продукт вообще существует.
     *
     * Всё предыдущее объясняет ленту для одного. Комнаты стоят
     * в конце не потому, что менее важны, а потому, что раньше
     * объяснять их нечем: человек ещё не видел ни одной карточки
     * и не понимает, что именно он будет делать вдвоём.
     *
     * Здесь единственный шаг, который указывает не на элемент ленты,
     * а на пункт навигации: дальше человеку идти туда.
     */
    key: 'rooms',
    target: '[data-coach="rooms"]',
    title: 'Вместе — комнаты на двоих',
    text: 'Один создаёт комнату, второй входит по коду или ссылке. '
      + 'Дальше вы листаете одну колоду, собранную не под кого-то одного, '
      + 'а под вас обоих. Совпало «нравится» у всех — это мэтч, фильм '
      + 'падает в общий список.',
    rows: [
      { icon: Users, tone: 'info', label: 'код из четырёх знаков или ссылка в чат' },
      { icon: Heart, tone: 'like', label: 'свайпает каждый со своего телефона' },
      { icon: PartyPopper, tone: 'wish', label: 'мэтч — когда «да» сказали оба' },
    ],
    place: 'above',
  },
];

export function DeckCoach({ active = false, onDone }) {
  return (
    <Coach steps={STEPS} seenKey={SEEN_KEY} area="deck" active={active} onDone={onDone} />
  );
}

/** Видел ли человек подсказки ленты. Проверяется до её показа. */
export const deckCoachSeen = () => coachSeen(SEEN_KEY);
