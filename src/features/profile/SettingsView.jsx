import {
  ArrowLeft, BarChart3, Check, Crown, Download, LogOut, Pencil, Sparkles,
  Vibrate, Volume2, VolumeX, Star, Lock,
} from '../../ui/icons.js';
import { StatusStrip } from '../../ui/States.jsx';
import { TelegramLinkCard } from './TelegramLinkCard.jsx';
import { PREMIUM_CONFIG, showcaseAllowed } from '../../../shared/config/premium.js';

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
  user, profile, prefs, access, premium,
  onBack, onEditProfile, onEditShowcase, onOpenPremium, onOpenDashboard,
  onPrefsChange, onLogout, auth, toasts,
}) {
  const { price, promo } = PREMIUM_CONFIG;
  const canShowcase = showcaseAllowed({ premium: premium?.premium });

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

      {/* ── Вход ──────────────────────────────────────────────── */}
      {/*
        * Карточке нужны разобранные поля, а не объект `auth` целиком.
        * При переносе экрана сюда уехал `auth={auth}` — и карточка,
        * не найдя ни `links`, ни `inTelegram`, честно писала «не привязан»
        * даже тому, кто зашёл из самого Mini App.
        */}
      {auth && (
        <TelegramLinkCard
          user={user}
          links={auth.links}
          inTelegram={auth.inTelegram}
          onLink={auth.linkTelegram}
          onUnlink={auth.unlinkTelegram}
          toast={toasts}
        />
      )}

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

      <div className="row row--wrap gap-3">
        {onOpenDashboard && (
          <button type="button" className="btn btn--ghost" onClick={onOpenDashboard}>
            <BarChart3 size={16} /> Метрики
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--danger grow" onClick={onLogout}>
          <LogOut size={16} /> Выйти
        </button>
      </div>

      {access?.tier === 'plus' && (
        <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>Тариф: Plus</p>
      )}
    </div>
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
