/**
 * Витрина `/welcome` — для тех, кто пришёл не из Telegram.
 *
 * Отдельная страница без React: у человека из поста или ролика десять
 * секунд, чтобы понять, что это, и тратить их на загрузку бандла
 * приложения незачем. Здесь только разметка, стили и три дела ниже.
 */

import './welcome.css';
import { normalizeSourceTag, sourceStartParam } from '../../shared/model/startParam.js';
import { canRefract, mountRefraction } from './refraction.js';

const BOT = (import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'MatchWatchApp_bot').replace(/^@/, '');
const APP = import.meta.env.VITE_TELEGRAM_APP_NAME || 'app';

/*
 * ── 1. Метка источника едет дальше ──────────────────────────────
 *
 * Ссылка на витрину подписана (`/welcome?utm_source=habr`), и подпись
 * не должна потеряться на следующем клике: в Telegram она уходит
 * в `startapp=src_habr`, в веб-версию — тем же `utm_source`. Без метки
 * источником считается сама витрина.
 */
const params = new URLSearchParams(window.location.search);
const source = normalizeSourceTag(params.get('utm_source') ?? params.get('src')) ?? 'welcome';

const telegramUrl = `https://t.me/${BOT}/${APP}?startapp=${sourceStartParam(source)}`;
const webUrl = `/?utm_source=${encodeURIComponent(source)}`;

for (const link of document.querySelectorAll('[data-cta="telegram"]')) link.href = telegramUrl;
for (const link of document.querySelectorAll('[data-cta="web"]')) link.href = webUrl;

/*
 * ── 2. Стена постеров ───────────────────────────────────────────
 *
 * Классика из топа TMDB — узнаётся с первого взгляда и не устаревает,
 * в отличие от «популярного на этой неделе». Пути взяты из нашего же
 * каталога; картинки идут с CDN TMDB, как и в самом приложении.
 */
const POSTERS = [
  'yvmKPlTIi0xdcFQIFcQKQJcI63W', 'hoowzozsn0XQGtgH8nyivAMZfPN', 'aPtN76OjnNKLqCJ2FJBnQOIL031',
  'txaVo4whnSduKuczZiJexhLDVQC', 'lHxe8t4B0CKv4DO0C0B4rsuiG95', '60q19ii6RRIWHzVREeLtXUEM42B',
  '9xL2PwIOerz8jld06J9cxwuJfoD', 'vReLRjDV9XPhiOSEW7QWow4DXwf', 'iH2WDCYLIUjc7oPWRT7Kxgxza6k',
  'qvbfoyW2zaI15c0quUfF6CRGH4H', '6fAVi5Iic2I1mvTW8vfp5kZPJjJ', '66RvLrRJTm4J8l3uHXWF09AICol',
  'seSip2zebLmHzDHfLstRF6yyqqq', '6UzaYYURo3T6e4jBHHWaUWRNayZ', 'ft6opiB2onxZe8PhSTba53wYpFb',
  'dB7edCQIuExWErWXFVqR7ORnZRS', 'uDFEvhvKrH61KuGWWozRtbw2Rjv', 'fGDK72duT0YbdORyNo1QVuzDYzE',
  'xUM7xcRNuWFAtwK8mYRWcqQNwKe', 'r25pROjJSaORRtyCkbbrEp9kMaL', 'k66mInzxbRSMCBousQwSnXWuo4G',
  'fl7QZlAoZ4MLcxvgOaBjeUxlpQt', 'vm0Ily4MkZTQCvoMeVnztFjdldG', 'tOLQ3iRDfbwhVaw3QjDzIOS7zcu',
];

const wall = document.querySelector('.wall');
if (wall) {
  const rows = 6;
  const perRow = 12;
  const fragment = document.createDocumentFragment();
  for (let r = 0; r < rows; r += 1) {
    const row = document.createElement('div');
    row.className = 'wall__row';
    for (let i = 0; i < perRow; i += 1) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w342/${POSTERS[(r * 7 + i * 5) % POSTERS.length]}.jpg`;
      img.alt = '';
      img.loading = r < 3 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.width = 171;
      img.height = 256;
      /* Постер, который не загрузился, не должен оставлять дыру со значком. */
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
      row.appendChild(img);
    }
    fragment.appendChild(row);
  }
  wall.appendChild(fragment);
}

/*
 * ── 3. Преломление ──────────────────────────────────────────────
 *
 * Включается после первой отрисовки: карта смещения считается по
 * размеру блока, а размер известен только когда шрифты встали.
 */
if (canRefract()) {
  document.documentElement.dataset.refract = 'on';
  const start = () => mountRefraction('[data-refract]');
  if (document.fonts?.ready) document.fonts.ready.then(start);
  else window.addEventListener('load', start, { once: true });
}
