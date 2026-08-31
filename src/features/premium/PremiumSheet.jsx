import { useEffect } from 'react';
import { Check, Crown, ShoppingCart, Sparkles, Star } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { trackMetric } from '../../lib/telemetry.js';
import { openTelegramLink } from '../../lib/telegram.js';
import { METRIC } from '../../../shared/telemetry/events.js';
import { PREMIUM_CONFIG } from '../../../shared/config/premium.js';

/**
 * Витрина премиума.
 *
 * Зачёркнутая цена здесь не приём из инфобизнеса, а единственный
 * способ сказать две вещи сразу: сколько подписка будет стоить и что
 * сейчас человек не платит. Без перечёркнутой суммы «бесплатно»
 * не сообщает ценности, а без нуля рядом — выглядит как счёт.
 *
 * Премиум сейчас не выдан всем — он стоит ноль рублей и берётся
 * нажатием. Разница принципиальная: выданное молча человек не замечает
 * и ничего этим не сообщает, а нажатие — это решение, которое можно
 * посчитать. Сколько дошли до витрины, сколько активировали, сколько
 * вернутся, когда цена перестанет быть нулевой.
 */
export function PremiumSheet({ open, onClose, premium, promoAvailable, daysLeft, busy, onActivate, onPurchase, toasts }) {
  const { price, promo, benefits, starsShop } = PREMIUM_CONFIG;

  /*
   * Переход к обменнику звёзд.
   *
   * `openTelegramLink` ЗАКРЫВАЕТ Mini App — это его штатное поведение,
   * а не сбой. Но если клиент по какой-то причине не откроет чат, для
   * человека остаётся только «приложение просто закрылось», и вернуться
   * ему некуда: ссылку он больше не видит.
   *
   * Поэтому перед уходом кладём ссылку в буфер и говорим об этом. Даже
   * в худшем случае у человека на руках есть адрес, который достаточно
   * вставить в поиск Telegram.
   */
  const openStarsShop = async () => {
    trackMetric(METRIC.PREMIUM_VIEWED, { context: { action: 'stars_shop' } });

    try {
      await navigator.clipboard?.writeText(starsShop.url);
      toasts?.push?.('Ссылка скопирована — открываем обменник');
    } catch {
      /* Буфер может быть недоступен; это не повод не открывать ссылку. */
    }

    openTelegramLink(starsShop.url);
  };

  useEffect(() => {
    if (!open) return;
    trackMetric(METRIC.PREMIUM_VIEWED, {
      context: { premium, promoAvailable },
    });
  }, [open, premium, promoAvailable]);

  const activate = async () => {
    const result = await onActivate?.();
    if (result?.ok) {
      toasts?.success(`Премиум активирован на ${promo.days} дней`);
      onClose?.();
    } else if (result?.error) {
      toasts?.error(result.error.message ?? 'Не удалось активировать');
    }
  };

  const pay = async () => {
    const result = await onPurchase?.();
    if (result?.ok) {
      toasts?.success('Оплата прошла — премиум активен');
      onClose?.();
      return;
    }
    /*
     * Отмену молча проглатываем: человек сам закрыл окно оплаты,
     * и говорить ему об этом — сообщать о его собственном решении.
     */
    if (result?.status && result.status !== 'cancelled') {
      toasts?.error('Оплата не прошла. Деньги не списаны.');
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="MatchWatch Премиум">
      <div className="stack gap-5">

        {premium && (
          <div className="premium-state">
            <Crown size={18} weight="fill" />
            <span className="stack gap-1">
              <b>Премиум активен</b>
              <span className="faint premium-state__note">
                Осталось {daysLeft} дн.
              </span>
            </span>
          </div>
        )}

        <div className="premium-price">
          {promoAvailable ? (
            <>
              <span className="premium-price__was">{price.label}</span>
              <span className="premium-price__now">{promo.priceLabel}</span>
              <span className="premium-price__note">{promo.label}</span>
            </>
          ) : (
            <>
              <span className="premium-price__now">{price.label}</span>
              <span className="premium-price__note">{price.labelPeriod}</span>
            </>
          )}
        </div>

        <ul className="premium-benefits">
          {benefits.map((item) => (
            <li key={item}>
              <Check size={15} weight="bold" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="stack gap-2">
          {promoAvailable ? (
            <button
              type="button"
              className="btn btn--primary btn--block btn--lg"
              disabled={busy}
              onClick={activate}
            >
              <Sparkles size={16} /> {busy ? 'Активируем…' : 'Активировать бесплатно'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--gold btn--block btn--lg"
              disabled={busy}
              onClick={pay}
            >
              <Star size={16} weight="fill" />
              {busy ? 'Открываем оплату…' : `Оплатить — ${price.stars} звёзд`}
            </button>
          )}

          {promoAvailable && (
            <button
              type="button"
              className="btn btn--quiet btn--block"
              disabled={busy}
              onClick={pay}
            >
              Оплатить звёздами — {price.stars} ★
            </button>
          )}
        </div>

        {/*
          * «Где купить звёзды» — под кнопкой оплаты, а не рядом с ней.
          *
          * Это запасной выход для тех, у кого звёзд не хватило, и стоять
          * он должен ровно там, где человек упрётся: после того, как
          * решил платить. Выше он отвлекал бы от самой оплаты.
          */}
        <button type="button" className="premium-shop" onClick={openStarsShop}>
          <ShoppingCart size={14} /> {starsShop.label}
        </button>

        <p className="faint premium-fineprint">
          {/*
            * «Карта не нужна» стоит первым и написано прямо.
            *
            * Это главное возражение против любой бесплатной подписки:
            * человек ждёт, что у него попросят реквизиты и спишут через
            * месяц. Пока он в этом не уверен, он не нажмёт кнопку —
            * и снимать это возражение надо там же, где кнопка.
            */}
          <b>Карту привязывать не нужно.</b> Оплата проходит внутри Telegram
          звёздами, и подписка не продлевается сама: когда месяц кончится,
          мы просто спросим ещё раз. Оплата картой появится позже.
          {' '}{starsShop.note} Если приложение закроется, а чат не откроется —
          ссылка уже скопирована, вставьте её в поиск Telegram.
        </p>
      </div>
    </Sheet>
  );
}
