/**
 * Жидкое стекло с настоящим преломлением — только для витрины.
 *
 * Край линзы толще середины, поэтому то, что под ним, изгибается:
 * картинка у кромки растягивается к краю, середина остаётся ровной.
 * Повторить это можно одним способом — картой смещения. Для каждого
 * стеклянного блока она рисуется на холсте под его точный размер и
 * радиус (своя у каждого: скругление общей картой не растянуть) и
 * подключается фильтром SVG через `backdrop-filter: url(#…)`.
 *
 * Работает только в Chromium: WebKit и Gecko SVG-фильтр в
 * backdrop-filter не применяют. Остальным остаётся обычное размытие
 * из CSS — стекло без изгиба, но со всем остальным светом.
 *
 * В приложении этого нет намеренно: под доком и кнопками колоды на
 * каждом свайпе едет карточка, и фильтр пересчитывался бы кадр за
 * кадром. Здесь под стеклом неподвижная стена постеров.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Кромка линзы, px: в этой полосе картинка изгибается. */
const BEZEL = 26;
/** Насколько далеко кромка тянет картинку, px. */
const STRENGTH = 22;
/** Карта рисуется в половину размера — фильтр сам её растянет, а считать вчетверо меньше. */
const MAP_SCALE = 0.5;

export function canRefract() {
  const brands = globalThis.navigator?.userAgentData?.brands ?? [];
  const chromium = brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|YaBrowser/i.test(brand));
  const calm = matchMedia('(prefers-reduced-transparency: reduce)').matches
    || matchMedia('(prefers-reduced-motion: reduce)').matches;
  /*
   * Телефон пропускаем даже с Chromium: страницу на нём листают пальцем,
   * и фильтр размером с экран пересчитывается на каждом кадре прокрутки.
   * Блюр из CSS там дешевле и выглядит почти так же.
   */
  const handheld = matchMedia('(pointer: coarse)').matches;
  return chromium && !calm && !handheld && CSS.supports('backdrop-filter', 'url(#lg)');
}

/**
 * Карта смещения для скруглённого прямоугольника.
 *
 * Красный канал — сдвиг по X, зелёный — по Y, 128 — «на месте».
 * Внутри кромки сдвиг направлен к центру и растёт к краю по дуге
 * окружности: так изгибается толстое стекло, а не кривое зеркало.
 */
function displacementMap(width, height, radius) {
  const w = Math.max(2, Math.round(width * MAP_SCALE));
  const h = Math.max(2, Math.round(height * MAP_SCALE));
  const r = Math.min(radius * MAP_SCALE, w / 2, h / 2);
  const bezel = BEZEL * MAP_SCALE;
  const hw = w / 2;
  const hh = h / 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  const data = image.data;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5 - hw;
      const py = y + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);

      // Глубина от кромки (знаковое расстояние со скруглением) и нормаль.
      let depth;
      let nx = 0;
      let ny = 0;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        depth = r - len;
        nx = (qx / len) * Math.sign(px);
        ny = (qy / len) * Math.sign(py);
      } else {
        depth = r - Math.max(qx, qy);
        if (qx > qy) nx = Math.sign(px);
        else ny = Math.sign(py);
      }

      const t = Math.min(1, Math.max(0, 1 - depth / bezel));
      const pull = 1 - Math.sqrt(1 - t * t);

      const i = (y * w + x) * 4;
      data[i] = 128 - nx * pull * 127;
      data[i + 1] = 128 - ny * pull * 127;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function svgNode(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * Подключает преломление ко всем `selector`. Возвращает функцию отключения.
 * Размер отслеживается: карта перерисовывается, когда блок меняет форму.
 */
export function mountRefraction(selector = '[data-refract]') {
  const nodes = [...document.querySelectorAll(selector)];
  if (!nodes.length) return () => {};

  const defs = svgNode('svg', { width: 0, height: 0, 'aria-hidden': 'true' });
  defs.style.position = 'absolute';
  document.body.appendChild(defs);

  const draw = (node, index) => {
    const { width, height } = node.getBoundingClientRect();
    if (width < 4 || height < 4) return;
    const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
    const id = `lg-refract-${index}`;

    defs.querySelector(`#${id}`)?.remove();
    const filter = svgNode('filter', {
      id, x: 0, y: 0, width, height,
      filterUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
    });
    filter.append(
      svgNode('feImage', {
        href: displacementMap(width, height, radius),
        x: 0, y: 0, width, height,
        preserveAspectRatio: 'none',
        result: 'map',
      }),
      svgNode('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'map',
        scale: STRENGTH * 2,
        xChannelSelector: 'R', yChannelSelector: 'G',
      }),
    );
    defs.appendChild(filter);

    const blur = node.dataset.refract === 'clear' ? 2 : 10;
    node.style.backdropFilter = `url(#${id}) blur(${blur}px) saturate(165%) brightness(1.06)`;
    node.classList.add('is-refracting');
  };

  let frame = 0;
  const pending = new Set();
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) pending.add(entry.target);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const node of pending) draw(node, nodes.indexOf(node));
      pending.clear();
    });
  });
  nodes.forEach((node) => observer.observe(node));

  return () => {
    observer.disconnect();
    defs.remove();
    nodes.forEach((node) => {
      node.style.backdropFilter = '';
      node.classList.remove('is-refracting');
    });
  };
}
