import { useEffect } from 'react';
import { Crown, Sparkles, Wrench, X } from '../../ui/icons.js';
import { NEWS_TAG, NEWS_TAG_LABEL } from '../../../shared/config/news.js';
import { PREMIUM_CONFIG } from '../../../shared/config/premium.js';
import { trackMetric } from '../../lib/telemetry.js';
import { METRIC } from '../../../shared/telemetry/events.js';

const ICONS = {
  [NEWS_TAG.PREMIUM]: Crown,
  [NEWS_TAG.FEATURE]: Sparkles,
  [NEWS_TAG.FIX]: Wrench,
};

/** Списки, на которые ссылаются записи. Один источник с витриной подписки. */
const LISTS = { premium: PREMIUM_CONFIG.benefits };

/**
 * Объявление во весь экран.
 *
 * Показывается один раз — при первом заходе после выхода обновления —
 * и занимает весь экран целиком, а не полоску сверху и не шторку снизу.
 *
 * Полноэкранное объявление стоит дорого: это единственный момент, когда
 * мы отнимаем у человека то, зачем он пришёл. Поэтому оно тут ровно одно
 * на обновление, закрывается в одно касание и больше не возвращается —
 * а всё остальное живёт в «Что нового», куда можно зайти самому.
 *
 * Цена показана зачёркнутой прямо здесь, а не спрятана за кнопкой:
 * человек должен понять, что предлагают и сколько это стоит, ещё до
 * того, как решит нажимать.
 */
export function NewsScreen({ item, onClose, onAction, onOpenAll }) {
  useEffect(() => {
    if (!item) return;
    trackMetric(METRIC.NEWS_SHOWN, { context: { id: item.id } });
  }, [item]);

  /* Пока объявление открыто, фон под ним прокручиваться не должен. */
  useEffect(() => {
    if (!item) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [item]);

  useEffect(() => {
    if (!item) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [item, onClose]);

  if (!item) return null;

  const Icon = ICONS[item.tag] ?? Sparkles;
  const isPremium = item.tag === NEWS_TAG.PREMIUM;
  const { price, promo } = PREMIUM_CONFIG;

  return (
    <div className="announce" role="dialog" aria-modal="true" aria-label={item.title} data-tag={item.tag}>
      <div className="announce__glow" aria-hidden="true" />

      <button type="button" className="announce__close" aria-label="Закрыть" onClick={onClose}>
        <X size={20} />
      </button>

      <div className="announce__body">
        <span className="announce__badge">
          <Icon size={13} weight="fill" /> {item.version ?? NEWS_TAG_LABEL[item.tag] ?? 'Новое'}
        </span>

        <span className="announce__crest"><Icon size={40} weight="fill" /></span>

        <h1 className="announce__title">{item.title}</h1>
        <p className="announce__lead">{item.lead}</p>

        {isPremium && (
          <div className="announce__price">
            <span className="announce__price-was">{price.label}</span>
            <span className="announce__price-now">{promo.priceLabel}</span>
            <span className="announce__price-note">{promo.label}</span>
          </div>
        )}

        {LISTS[item.listFrom] && (
          <ul className="announce__list">
            {LISTS[item.listFrom].map((benefit) => (
              <li key={benefit}>
                <Crown size={13} weight="fill" />
                <span>{benefit}</span>
              </li>
            ))}
          </ul>
        )}

        {/*
          * У записи без списка выгод показываем ПЕРВЫЙ абзац, а не все:
          * полноэкранное объявление — обложка, а не статья. Остальное
          * человек прочитает в дневнике, куда ведёт кнопка.
          */}
        {!LISTS[item.listFrom] && item.body[0] && (
          <p className="announce__text">{item.body[0]}</p>
        )}

        {isPremium && (
          <p className="announce__fineprint">
            Карту привязывать не нужно, ничего не спишется, и продлеваться
            сама подписка не будет. Дальше — {price.label} или {price.stars} звёзд в месяц.
          </p>
        )}
      </div>

      <div className="announce__actions">
        {/*
          * Подпись кнопки задаёт сама запись: «Подключить за 0 ₽»
          * и «Подробнее» ведут в разные места и обещают разное,
          * а одна общая формулировка врала бы в одном из случаев.
          */}
        <button type="button" className="btn btn--gold btn--block btn--lg" onClick={onAction}>
          {isPremium ? <Crown size={17} weight="fill" /> : <Sparkles size={17} />}
          {item.cta ?? (isPremium ? 'Подключить за 0 ₽' : 'Посмотреть')}
        </button>

        <div className="row gap-2">
          <button type="button" className="btn btn--quiet btn--block" onClick={onClose}>
            Позже
          </button>
          {/*
            * «Все обновления» прячем, когда туда же ведёт и главная кнопка:
            * две кнопки в одно место читаются как разные исходы, и человек
            * тратит выбор там, где выбора нет.
            */}
          {onOpenAll && item.action !== 'news' && (
            <button type="button" className="btn btn--quiet btn--block" onClick={onOpenAll}>
              Все обновления
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
