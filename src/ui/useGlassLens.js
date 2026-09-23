import { useState } from 'react';

/**
 * Жидкая линза — выбранный пункт, который перетекает, а не перескакивает.
 *
 * Сама линза — псевдоэлемент дорожки, лишнего узла в разметке нет:
 * компонент отдаёт только номер выбранного пункта и их число, а
 * положение и растяжение считает CSS (`glass.css`, `[data-lens]`).
 *
 * Растяжение в пути — анимация, а её перезапускает только смена имени.
 * Поэтому каждое перемещение переключает чётность, и CSS берёт то одно,
 * то другое имя одинаковых ключевых кадров. Первый показ — `rest`:
 * иначе линза вздрагивала бы при каждом открытии экрана, хотя никуда
 * не ехала.
 *
 * @param {number} index номер выбранного пункта; -1 — не выбран ни один
 * @param {number} count сколько пунктов на дорожке
 * @returns {{'data-lens': string, style: Record<string, number>}}
 */
export function useGlassLens(index, count) {
  const [seen, setSeen] = useState(index);
  const [moves, setMoves] = useState(0);

  /*
   * Сверка с прошлым рендером прямо во время рендера — так React
   * советует хранить «что было в прошлый раз»: эффект отдал бы
   * перемещение на кадр позже, и линза успела бы доехать без растяжения.
   */
  if (index !== seen) {
    setSeen(index);
    setMoves((n) => n + 1);
  }

  let state = 'rest';
  if (index < 0) state = 'idle';
  else if (moves > 0) state = moves % 2 ? 'odd' : 'even';

  return {
    'data-lens': state,
    style: { '--lens-i': Math.max(index, 0), '--lens-n': Math.max(count, 1) },
  };
}
