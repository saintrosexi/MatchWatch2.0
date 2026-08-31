import { useEffect, useState } from 'react';
import { Check, Crown, ShoppingCart, Sparkles, Star } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { trackMetric } from '../../lib/telemetry.js';
import { getInitData, requestWriteAccess } from '../../lib/telegram.js';
import { api } from '../../lib/api.js';
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

  const [sendingLink, setSendingLink] = useState(false);

  /*
   * Ссылку на обменник ПРИСЫЛАЕТ БОТ, а не открывает приложение.
   *
   * `openTelegramLink` штатно закрывает Mini App, и если клиент не
   * откроет чат — на Telegram Desktop так и происходит, — человек
   * остаётся с закрывшимся приложением, без объяснения и без ссылки.
   *
   * Сообщение решает это целиком: приложение не закрывается, ссылка
   * лежит в чате, по ней можно нажать когда угодно и вернуться позже.
   *
   * Родное окно «поделиться» (`shareMessage`) здесь не подходит и это
   * не упущение: оно отправляет сообщение ДРУГОМУ человеку, а обменник
   * человек открывает себе. Отсюда и разница с приглашением в комнату.
   *
   * Порядок попыток: сообщение от бота → если писать нельзя, спрашиваем
   * разрешение и пробуем снова → копия ссылки. Приложение не
   * закрывается ни на одном из шагов.
   */
  const openStarsShop = async () => {
    if (sendingLink) return;
    trackMetric(METRIC.PREMIUM_VIEWED, { context: { action: 'stars_shop' } });
    setSendingLink(true);

    try {
      const initData = getInitData();
      if (!initData) { fallbackToLink(); return; }

      let result = await api.sendLink('stars_shop', initData);

      /*
       * Боту ещё не разрешали писать. Спрашиваем прямо здесь: это
       * одно касание и ровно то разрешение, которого не хватает.
       */
      if (result?.reason === 'no_chat' && await requestWriteAccess()) {
        await api.allowNotifications(initData);
        result = await api.sendLink('stars_shop', initData);
      }

      if (result?.sent) {
        toasts?.success?.('Отправили ссылку в Telegram — она в чате с ботом');
        return;
      }

      fallbackToLink();
    } catch {
      fallbackToLink();
    } finally {
      setSendingLink(false);
    }
  };

  /*
   * Запасной путь: копия ссылки, без закрытия приложения.
   *
   * Раньше отсюда открывался `openTelegramLink`, и он Mini App
   * закрывает. Для приглашения в комнату мы от этого уже отказались,
   * и здесь причина та же: человек нажал одну кнопку в витрине
   * подписки — выбрасывать его из витрины за это нельзя, тем более
   * что он собирался платить.
   *
   * Ссылка в буфере решает задачу целиком: обменник ищется вставкой
   * в поиск Telegram, а витрина остаётся на месте.
   */
  const fallbackToLink = async () => {
    try {
      await navigator.clipboard?.writeText(starsShop.url);
      toasts?.push?.('Ссылка на обменник скопирована — вставьте её в поиск Telegram');
    } catch {
      /* Буфера нет — тогда ссылка остаётся видимой строкой ниже. */
      toasts?.error?.(`Не удалось скопировать. Обменник: ${starsShop.url}`);
    }
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
        <button
          type="button"
          className="premium-shop"
          onClick={openStarsShop}
          disabled={sendingLink}
        >
          <ShoppingCart size={14} /> {sendingLink ? 'Отправляем…' : starsShop.label}
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
          {' '}{starsShop.note} Ссылку пришлёт бот в Telegram — витрина
          при этом не закроется.
        </p>
      </div>
    </Sheet>
  );
}
