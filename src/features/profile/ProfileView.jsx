import { Crown, Lock, Settings, Share2, Sparkles, Users } from '../../ui/icons.js';
import { PublicProfileView } from './PublicProfileView.jsx';
import { shareViaInlineQuery, shareToTelegram, profileLink } from '../../lib/telegram.js';
import { PREMIUM_CONFIG, showcaseAllowed } from '../../../shared/config/premium.js';

/**
 * «Я» — та же страница, которую видят все остальные.
 *
 * Раньше это был отдельный экран: наполовину витрина, наполовину панель
 * управления. Рядом с любимыми фильмами стояли привязка Telegram,
 * тумблеры звука и кнопка выхода, а само оформление профиля — цвет,
 * фактуру, закреплённое — человек не видел вообще: всё это существует
 * только на публичной странице, куда он к себе не заходит.
 *
 * Теперь экран один. Владелец видит ровно то, что увидит гость, и правит
 * это, глядя на результат, а не на форму. Всё служебное уехало
 * в настройки профиля: оно нужно изредка и только ему.
 *
 * Наверху остаётся полоса, которой у гостя нет, — подписка, друзья,
 * витрина и настройки. Это управление, а не содержание, поэтому оно
 * стоит НАД страницей, а не внутри неё.
 */
export function ProfileView({
  user, profile, premium, toasts,
  onOpenPremium, onOpenSettings, onOpenFriends, onOpenTitle, onEditShowcase,
}) {
  const { price, promo } = PREMIUM_CONFIG;
  const canShowcase = showcaseAllowed({ premium: premium?.premium });
  const username = profile?.username;

  const share = () => {
    if (!username) {
      toasts?.error?.('Сначала задайте ник — по нему вас и найдут');
      return;
    }
    /* Инлайн-режим — родной выбор чата. Не вышло — обычный шеринг ссылки. */
    if (shareViaInlineQuery(`profile ${username}`, ['users', 'groups'])) return;

    const link = profileLink(username);
    if (link && shareToTelegram({ url: link, text: 'Мой профиль в MatchWatch' })) return;
    if (link) {
      navigator.clipboard?.writeText(link);
      toasts?.success?.('Ссылка на профиль скопирована');
    }
  };

  return (
    <div className="stack gap-4">
      <div className="me-bar">
        <button type="button" className="me-bar__premium" onClick={onOpenPremium}>
          <Crown
            size={17}
            weight={premium?.premium ? 'fill' : 'regular'}
            color={premium?.premium ? 'var(--gold)' : 'var(--text-mid)'}
          />
          <span className="stack gap-1" style={{ textAlign: 'left', minWidth: 0 }}>
            <b className="me-bar__title">
              {premium?.premium ? 'Премиум активен' : 'Подключить премиум'}
            </b>
            <span className="me-bar__note">
              {premium?.premium
                ? `осталось ${premium.daysLeft} дн.`
                : premium?.promoAvailable
                  ? `${price.label} → ${promo.priceLabel} на первый месяц`
                  : `${price.label} в месяц`}
            </span>
          </span>
          {premium?.promoAvailable && <span className="chip chip--gold">бесплатно</span>}
        </button>

        <div className="row row--wrap gap-2">
          {onOpenFriends && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenFriends}>
              <Users size={16} /> Друзья
            </button>
          )}
          {/*
            * Без подписки кнопка ведёт не в редактор, а в витрину
            * подписки. Показывать редактор с запертой половиной хуже,
            * чем не показывать вовсе: человек тратит время, чтобы
            * выяснить, что ему нельзя.
            */}
          {onEditShowcase && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={canShowcase ? onEditShowcase : onOpenPremium}
            >
              {canShowcase ? <Sparkles size={16} /> : <Lock size={14} />} Витрина
            </button>
          )}
          {/*
            * Поделиться профилем — через инлайн-режим бота.
            *
            * Открывается родной выбор чата Telegram: список контактов
            * остаётся у клиента, к нам он не попадает и попасть не может —
            * контакты приложениям не выдаются вовсе. Человек выбирает
            * сам, а бот кладёт в чат карточку со ссылкой.
            */}
          <button type="button" className="btn btn--ghost btn--sm" onClick={share}>
            <Share2 size={16} /> Поделиться
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenSettings}>
            <Settings size={16} /> Настройки
          </button>
        </div>
      </div>

      {/*
        * Страница берётся у сервера, как у гостя, а не собирается
        * из локального состояния. Иначе владелец видел бы не то, что
        * видят другие: скрытые разделы, отключённую видимость оценок,
        * незаданный ник — всё это учитывается только на сервере.
        */}
      <PublicProfileView
        userId={user?.uid}
        onOpenTitle={onOpenTitle}
        onEditShowcase={canShowcase ? onEditShowcase : onOpenPremium}
        onOpenPremium={onOpenPremium}
        toasts={toasts}
        key={profile?.username ?? user?.uid}
      />
    </div>
  );
}
