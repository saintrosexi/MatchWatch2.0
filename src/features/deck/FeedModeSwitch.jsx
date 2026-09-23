import { Flame, Heart } from '../../ui/icons.js';
import { useGlassLens } from '../../ui/useGlassLens.js';

/**
 * Переключатель режима ленты.
 *
 * Два состояния, а не список: выбор между «полистать своё» и «покажи
 * другое» человек делает не глядя, на ходу, и лишний экран настроек
 * здесь означал бы, что переключать не будут вовсе.
 *
 * Обе подписи видны всегда: у крупного тумблера посреди экрана скрытая
 * половина читается как одна кнопка с непонятной иконкой, и человек
 * не видит, между чем выбирает.
 */
/*
 * Сердце и огонь, а не сердце и компас. Огонь читается как «горячее,
 * новое» — то есть ровно как обещание второго режима; компас обещал
 * навигацию, которой здесь нет.
 */
const MODES = [
  { key: 'calm', label: 'Моё', icon: Heart, hint: 'Похожее на любимое' },
  { key: 'discovery', label: 'Другое', icon: Flame, hint: 'Незнакомое и по сегодняшнему настроению' },
];

export function FeedModeSwitch({ value = 'calm', onChange }) {
  const lens = useGlassLens(MODES.findIndex((m) => m.key === value), MODES.length);

  return (
    <div className="feed-switch" role="group" aria-label="Режим ленты" {...lens}>
      {MODES.map(({ key, label, icon: Icon, hint }) => {
        const on = value === key;
        return (
          <button
            key={key}
            type="button"
            className={`feed-switch__item ${on ? 'feed-switch__item--on' : ''}`}
            aria-pressed={on}
            title={hint}
            onClick={() => onChange?.(key)}
          >
            <Icon size={16} weight={on ? 'fill' : 'regular'} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
