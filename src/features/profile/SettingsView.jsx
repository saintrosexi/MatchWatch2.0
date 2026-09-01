import {
  ArrowLeft, BarChart3, Check, Crown, Download, LogOut, Pencil, Sparkles,
  Vibrate, Volume2, VolumeX, Star, Lock, Send, Newspaper,
  Megaphone, Chats, Lifebuoy, ExternalLink, ShoppingCart,
} from '../../ui/icons.js';
import { useEffect, useState } from 'react';
import { StatusStrip } from '../../ui/States.jsx';
import { isBotStarted } from '../../engine/social.js';
import {
  getInitData, keepsAppOpenOnTelegramLink, openTelegramLink, requestWriteAccess,
} from '../../lib/telegram.js';
import { api } from '../../lib/api.js';
import { ENV } from '../../lib/env.js';
import { PREMIUM_CONFIG, showcaseAllowed } from '../../../shared/config/premium.js';
import { officialAccounts } from '../../../shared/config/contacts.js';
import { RELEASE } from '../../../shared/config/news.js';

/**
 * Настройки профиля — всё служебное за одной дверью.
 *
 * До этого экран «Я» был наполовину витриной, наполовину панелью
 * управления: рядом с любимыми фильмами стояли привязка Telegram,
 * тумблеры звука и кнопка выхода. Из-за этого человек не видел
 * собственный профиль так, как его видят другие, — а профиль
 * существует ровно затем, чтобы его видели.
 *
 * Теперь «Я» показывает ту же страницу, что и всем остальным,
 * а сюда собрано то, что нужно изредка и только владельцу.
 *
 * Порядок разделов — по частоте обращения, а не по важности:
 * оформление правят часто, выходят из аккаунта раз в жизни.
 */
export function SettingsView({
  profile, prefs, access, premium,
  onBack, onEditProfile, onEditShowcase, onOpenPremium, onOpenDashboard,
  onPrefsChange, onLogout, onOpenFeedback, onOpenNews, toasts,
}) {
  const { price, promo } = PREMIUM_CONFIG;
  const canShowcase = showcaseAllowed({ premium: premium?.premium });

  /* `null` — ещё не знаем; предупреждать до ответа сервера нельзя. */
  const [botStarted, setBotStarted] = useState(null);

  useEffect(() => {
    let alive = true;
    isBotStarted()
      .then((ok) => { if (alive) setBotStarted(ok); })
      .catch(() => { /* не знаем — молчим, пугать зря хуже */ });
    return () => { alive = false; };
  }, []);

  const [asking, setAsking] = useState(false);

  /*
   * Включение уведомлений.
   *
   * Сначала родное окно Telegram «разрешить боту писать вам?»: одно
   * касание, не выходя из приложения вовсе. Оно остаётся первым не
   * потому, что ссылка плоха, а потому, что ссылка требует нажать
   * в чате Start руками, — а окно даёт то же самое разрешение в одно
   * касание и не уводит никуда.
   *
   * Ссылка осталась запасным путём — для старых клиентов, где родного
   * окна нет, и для отказа: там человеку и правда некуда идти, кроме
   * чата с ботом. И это больше не «выкинет неизвестно куда»: с Bot API
   * 7.0 переход по `t.me` сворачивает приложение в плашку и открывает
   * чат поверх — см. `keepsAppOpenOnTelegramLink`.
   */
  const enableNotifications = async () => {
    if (asking) return;
    setAsking(true);
    try {
      const granted = await requestWriteAccess();
      const initData = getInitData();

      if (granted && initData) {
        /* Разрешение живёт у Telegram; рассыльщик узнаёт о нём отсюда. */
        const result = await api.allowNotifications(initData);

        /*
         * `linked: false` — разрешение записано, но не на этот профиль:
         * аккаунт заведён по почте, а Telegram другой. Полосу не гасим
         * и «готово» не говорим, иначе человек будет ждать сообщений,
         * которые никогда не придут.
         */
        if (result?.linked === false) {
          toasts?.error?.('Этот Telegram не привязан к аккаунту — войдите через Telegram');
          return;
        }

        /*
         * Гасим полосу только по ответу сервера, а не по факту нажатия.
         *
         * Оптимистичное «теперь всё хорошо» — самая дорогая ложь в этом
         * месте: человек перестаёт видеть предупреждение и начинает
         * ждать сообщений, которые не придут. Спрашиваем заново: может
         * ли он теперь их получать.
         */
        const confirmed = await isBotStarted();
        setBotStarted(confirmed);

        if (confirmed) toasts?.success?.('Готово — уведомления придут в Telegram');
        else toasts?.error?.('Разрешение получено, но доставка не подтвердилась. Напишите боту сами.');
        return;
      }

      /*
       * Родного окна нет или человек отказался — остаётся чат с ботом,
       * и туда мы его именно ОТВОДИМ, а не рассказываем, как дойти.
       */
      openBotChat();
    } catch {
      openBotChat();
    } finally {
      setAsking(false);
    }
  };

  /*
   * Чат с ботом — переходом, а не сообщением о переходе.
   *
   * Предупреждение подбирается под клиент, потому что происходит разное.
   * На 7.0+ приложение остаётся: оно сворачивается в плашку, и обещать
   * человеку возврат можно честно. На клиентах старше Mini App правда
   * закроется — и сказать об этом надо ДО нажатия, а не поставить перед
   * фактом.
   */
  const openBotChat = () => {
    const bot = ENV.telegramBot;
    if (!bot) {
      toasts?.error?.('Бот не настроен — напишите нам через «Написать нам»');
      return;
    }

    toasts?.push?.(keepsAppOpenOnTelegramLink()
      ? 'Открыли чат с ботом — нажмите там Start и возвращайтесь, приложение на месте'
      : 'Открываем чат с ботом — нажмите там Start и вернитесь в приложение');

    openTelegramLink(`https://t.me/${bot}?start=notify`);
  };

  /*
   * Официальные аккаунты.
   *
   * Список собирается конфигом, а не разметкой: канала у нас ещё нет,
   * и когда он появится, добавить его надо одной строкой в
   * `shared/config/contacts.js`, а не правкой этого экрана.
   */
  const accounts = officialAccounts({
    bot: ENV.telegramBot,
    starsShop: PREMIUM_CONFIG.starsShop,
  });

  const openAccount = (account) => {
    if (!keepsAppOpenOnTelegramLink()) {
      toasts?.push?.(`Открываем «${account.title}» в Telegram — приложение закроется`);
    }
    openTelegramLink(account.url);
  };

  return (
    <div className="view">
      <header className="view__head">
        <div className="row gap-3" style={{ alignItems: 'center' }}>
          {onBack && (
            <button type="button" className="action action--sm" aria-label="Назад" onClick={onBack}>
              <ArrowLeft size={18} />
            </button>
          )}
          <h1 className="view__title">Настройки профиля</h1>
        </div>
        <p className="view__sub">Всё, что видите только вы.</p>
      </header>

      {/*
        * Уведомления не включатся сами.
        *
        * Telegram не даёт боту написать первым, а Mini App открывается
        * ссылкой мимо чата с ботом — большинство пришедших Start
        * не нажимают вовсе, и заявки в друзья с приглашениями в комнату
        * молча копятся в очереди. Полоса ведёт прямо в чат.
        */}
      {botStarted === false && (
        <StatusStrip
          tone="warn"
          /*
           * Скрыть нельзя намеренно. Крестик убирал предупреждение,
           * ничего не починив, — и человек оставался без уведомлений,
           * считая вопрос закрытым. Полоса уходит только когда сервер
           * подтвердил, что доставка возможна.
           */
          dismissible={false}
          action={{ label: asking ? 'Спрашиваем…' : 'Включить', onClick: enableNotifications }}
        >
          Уведомления выключены: бот не сможет написать, пока вы не нажмёте
          у него Start. Без этого не придут ни заявки в друзья, ни
          приглашения в комнату.
        </StatusStrip>
      )}

      {!profile?.username && (
        <StatusStrip tone="warn" action={{ label: 'Задать', onClick: onEditProfile }}>
          Задайте ник — без него друзья не смогут вас найти.
        </StatusStrip>
      )}

      {/* ── Оформление ────────────────────────────────────────── */}
      <section className="section">
        <h2 className="section__title">Профиль</h2>
        <div className="stack gap-2">
          <SettingLink
            icon={Pencil}
            label="Имя, ник и описание"
            hint={profile?.username ? `@${profile.username}` : 'ник не задан'}
            onClick={onEditProfile}
          />
          {/* Без подписки ведёт в витрину подписки, а не в редактор. */}
          {onEditShowcase && (
            <SettingLink
              icon={canShowcase ? Sparkles : Lock}
              label="Витрина"
              hint={canShowcase
                ? 'Что из отмеченного показывать другим: закреплённое, фильм про себя, цвет и фактура'
                : 'Настройка страницы — в премиуме. Сейчас она собирается сама.'}
              onClick={canShowcase ? onEditShowcase : onOpenPremium}
            />
          )}
        </div>
      </section>

      {/* ── Подписка ──────────────────────────────────────────── */}
      <section className="section">
        <h2 className="section__title">Премиум</h2>

        <button type="button" className="member" style={{ cursor: 'pointer', width: '100%' }} onClick={onOpenPremium}>
          <Crown
            size={20}
            color={premium?.premium ? 'var(--gold)' : 'var(--text-mid)'}
            weight={premium?.premium ? 'fill' : 'regular'}
          />
          <span className="stack grow" style={{ textAlign: 'left' }}>
            <span className="member__name">
              {premium?.premium ? 'Премиум активен' : 'Подключить премиум'}
            </span>
            <span className="member__state">
              {premium?.premium
                ? `Осталось ${premium.daysLeft} дн.`
                : premium?.promoAvailable
                  ? `${price.label} → ${promo.priceLabel} на первый месяц`
                  : `${price.label} или ${price.stars} звёзд в месяц`}
            </span>
          </span>
          {premium?.promoAvailable && <span className="chip chip--gold">бесплатно</span>}
        </button>

        {/*
          * Что входит, а что и так есть.
          *
          * Список выгод показывает только половину правды — ту, за которую
          * платят. Человеку важнее вторая: что он не потеряет, если
          * не заплатит. Без неё подписка читается как «продукт урезали».
          */}
        <div className="plan-grid">
          <div className="plan">
            <span className="plan__title">Бесплатно</span>
            <ul className="plan__list">
              <li>Лента, свайпы и все четыре решения</li>
              <li>Списки, оценки и профиль вкуса</li>
              <li>Совместный выбор кино</li>
              <li>Три комнаты в месяц</li>
              <li>Шесть фильмов в визитке</li>
            </ul>
          </div>
          <div className="plan plan--premium">
            <span className="plan__title"><Crown size={13} weight="fill" /> С премиумом</span>
            <ul className="plan__list">
              {PREMIUM_CONFIG.benefits.map((item) => (
                <li key={item}><Check size={13} /> {item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Импорт ────────────────────────────────────────────── */}
      <section className="section">
        <h2 className="section__title">Импорт оценок</h2>
        <div className="member" style={{ borderStyle: 'dashed' }}>
          <Download size={20} color="var(--text-mid)" />
          <span className="stack grow">
            <span className="member__name">Из Кинопоиска</span>
            <span className="member__state">
              Перенесём оценки и просмотренное — подборка сразу станет вашей.
            </span>
          </span>
          <span className="chip">в работе</span>
        </div>
      </section>

      {/* ── Приложение ────────────────────────────────────────── */}
      <section className="section">
        <h2 className="section__title">Приложение</h2>
        <div className="stack gap-2">
          <SettingRow
            icon={prefs.sound ? Volume2 : VolumeX}
            label="Звуки"
            hint="Отклик на свайпы и фанфара мэтча"
            checked={prefs.sound}
            onChange={(v) => onPrefsChange({ sound: v })}
          />
          <SettingRow
            icon={Vibrate}
            label="Тактильный отклик"
            hint="Нативная вибрация Telegram"
            checked={prefs.haptics}
            onChange={(v) => onPrefsChange({ haptics: v })}
          />
          <SettingRow
            icon={Star}
            label="Предлагать оценить"
            hint="Спрашиваем про фильм после свайпа — оценка уточняет ленту"
            checked={prefs.ratePrompt !== false}
            onChange={(v) => onPrefsChange({ ratePrompt: v })}
          />
        </div>
      </section>

      {/* ── О приложении ──────────────────────────────────────── */}
      {/*
        * Дневник разработки живёт здесь, а не только в разовом
        * объявлении. Объявление закрывается один раз и навсегда —
        * страница, до которой можно было добраться только через него,
        * была не спрятана, а недостижима.
        *
        * Обратная связь стоит следом намеренно: прочитал, что мы
        * сделали, — тут же есть чем ответить.
        */}
      <section className="section">
        <h2 className="section__title">О приложении</h2>
        <div className="stack gap-2">
          {onOpenNews && (
            <SettingLink
              icon={Newspaper}
              label="Дневник разработки"
              hint={`Что нового в ${RELEASE} — и почему сделано именно так`}
              onClick={onOpenNews}
            />
          )}
          <SettingLink
            icon={Send}
            label="Написать нам"
            hint="Что мешает, что раздражает, чего не хватает — читаем всё"
            onClick={onOpenFeedback}
          />
        </div>
      </section>

      {/* ── Наши в Telegram ───────────────────────────────────── */}
      {/*
        * Официальные аккаунты — списком, по которому можно нажать.
        *
        * До этого попасть в чат с ботом можно было только окольно:
        * приложение просило бота прислать сообщение и говорило «ссылка
        * в чате». Это работало, но это не переход, а рассказ о переходе:
        * человек нажал кнопку и остался там же, где был, с обещанием.
        *
        * Прямая ссылка была бы лучше всегда, и раньше её здесь не было
        * по одной причине — считалось, что `openTelegramLink` закрывает
        * Mini App. С Bot API 7.0 это не так: чат открывается ПОВЕРХ,
        * приложение сворачивается в плашку и ждёт. Ровно так это
        * работает во всех нормальных сервисах внутри Telegram, и ровно
        * так теперь работает у нас.
        *
        * Стрелка из квадрата у каждой строки — не украшение: она
        * отличает переход в Telegram от перехода внутри приложения,
        * а в этом списке ошибиться неприятнее всего.
        */}
      {accounts.length > 0 && (
        <section className="section">
          <h2 className="section__title">Наши в Telegram</h2>
          <div className="stack gap-2">
            {accounts.map((account) => (
              <AccountLink key={account.key} account={account} onOpen={openAccount} />
            ))}
          </div>
        </section>
      )}

      <div className="row row--wrap gap-3">
        {/*
          * Дашборд видит только владелец.
          *
          * Раньше кнопка стояла у всех, а сервер отвечал 403: человек
          * жал на неё и получал отказ за то, что нажал на предложенное.
          * Признак `is_ops` приходит в профиле и с клиента не меняется —
          * права на запись в эту колонку у роли нет.
          */}
        {onOpenDashboard && profile?.is_ops && (
          <button type="button" className="btn btn--ghost" onClick={onOpenDashboard}>
            <BarChart3 size={16} /> Дашборд
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--danger grow" onClick={onLogout}>
          <LogOut size={16} /> Выйти
        </button>
      </div>

      {/* Версия внизу — там, где её ищут, и там, где она никому не мешает. */}
      <p className="faint" style={{ fontSize: 'var(--t-micro)', textAlign: 'center' }}>
        MatchWatch {RELEASE}
        {access?.tier === 'plus' && ' · тариф Plus'}
      </p>
    </div>
  );
}

/**
 * Иконка по виду аккаунта. Рупор — канал, кружки — чат, круг — поддержка,
 * тележка — обменник, самолётик — бот. Разные значки нужны не для красоты:
 * в списке из пяти одинаковых строк человек читает подпись, только если
 * картинка рядом с ней уже подсказала, о чём речь.
 */
const ACCOUNT_ICON = {
  bot: Send,
  channel: Megaphone,
  chat: Chats,
  support: Lifebuoy,
  shop: ShoppingCart,
};

/** Строка официального аккаунта: ведёт наружу, в Telegram. */
function AccountLink({ account, onOpen }) {
  const Icon = ACCOUNT_ICON[account.kind] ?? Send;
  return (
    <button
      type="button"
      className="member"
      style={{ cursor: 'pointer', width: '100%' }}
      onClick={() => onOpen(account)}
    >
      <Icon size={20} color="var(--text-mid)" />
      <span className="stack grow" style={{ textAlign: 'left' }}>
        <span className="member__name">{account.title}</span>
        <span className="member__state">{account.note}</span>
      </span>
      <ExternalLink size={16} color="var(--text-mid)" aria-hidden />
    </button>
  );
}

/** Строка-переход: ведёт в отдельное окно, а не переключает флаг. */
function SettingLink({ icon: Icon, label, hint, onClick }) {
  return (
    <button type="button" className="member" style={{ cursor: 'pointer', width: '100%' }} onClick={onClick}>
      <Icon size={20} color="var(--text-mid)" />
      <span className="stack grow" style={{ textAlign: 'left' }}>
        <span className="member__name">{label}</span>
        <span className="member__state">{hint}</span>
      </span>
    </button>
  );
}

function SettingRow({ icon: Icon, label, hint, checked, onChange }) {
  return (
    <label className="member" style={{ cursor: 'pointer' }}>
      <Icon size={20} color="var(--text-mid)" />
      <span className="stack grow">
        <span className="member__name">{label}</span>
        <span className="member__state">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 20, height: 20, accentColor: 'var(--coral)' }}
      />
    </label>
  );
}
