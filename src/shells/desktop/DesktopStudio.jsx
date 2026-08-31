import { WifiOff } from '../../ui/icons.js';
import { BrandLockup, BrandMark } from '../../ui/Brand.jsx';

/**
 * Desktop Cinema Studio.
 *
 * Боковая панель, широкая сцена и правая колонка с деталями — на большом
 * экране незачем прятать описание фильма в модалку: оно помещается рядом
 * с карточкой, и решение принимается быстрее.
 */
export function DesktopStudio({
  nav, secondaryNav = [], active, onNavigate, title, subtitle, actions, children,
  user, online = true, onLogout, onOpenProfile,
}) {
  return (
    <div className="studio">
      <aside className="studio__side">
        <div className="studio__brand">
          {/* На узкой панели остаётся только знак — слово прячет CSS. */}
          <BrandMark size={44} />
          <span className="stack studio__brand-text">
            <span className="studio__brand-name">
              <span className="brand__word-a">Match</span><span className="brand__word-b">Watch</span>
            </span>
            <span className="studio__brand-sub">Cinema Studio</span>
          </span>
        </div>

        <nav className="studio__nav" aria-label="Основная навигация">
          {nav.map((item) => (
            <button
              key={item.key}
              type="button"
              className="studio__nav-item"
              /* Якорь для обучающих подсказок — см. `DeckCoach`. */
              data-coach={item.coach}
              /* Пункт может вести не во «вкладку», а в её часть — тогда
                 он сам знает, выбран ли, и сам решает, что открыть. */
              aria-current={(item.current ?? active === item.key) ? 'page' : undefined}
              onClick={() => (item.onSelect ? item.onSelect() : onNavigate(item.key))}
              title={item.label}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
              {item.badge > 0 && <span className="studio__nav-count">{item.badge}</span>}
            </button>
          ))}
        </nav>

        {/*
          * На телефоне «Я» — одна вкладка с переключателем: места внизу
          * ровно на пять пунктов. В боковом меню места хватает, и прятать
          * друзей за переключателем незачем — это отдельный маршрут.
          */}
        {secondaryNav.length > 0 && (
          <nav className="studio__nav studio__nav--secondary" aria-label="Аккаунт">
            {secondaryNav.map((item) => (
              <button
                key={item.key}
                type="button"
                className="studio__nav-item"
                aria-current={item.current ? 'page' : undefined}
                onClick={item.onSelect}
                title={item.label}
              >
                <item.icon size={20} />
                <span>{item.label}</span>
                {item.badge > 0 && <span className="studio__nav-count">{item.badge}</span>}
              </button>
            ))}
          </nav>
        )}

        {user && (
          <div className="studio__user">
            {user.photoURL
              ? <img className="member__avatar" style={{ width: 34, height: 34 }} src={user.photoURL} alt="" />
              : <span className="member__avatar" style={{ width: 34, height: 34 }} />}
            <span className="stack grow studio__user-text" style={{ minWidth: 0 }}>
              <span className="truncate" style={{ fontSize: 'var(--t-small)', fontWeight: 600 }}>
                {user.displayName}
              </span>
              <button type="button" className="btn btn--quiet btn--sm" style={{ padding: 0, minHeight: 0, justifyContent: 'flex-start' }} onClick={onLogout}>
                выйти
              </button>
            </span>
          </div>
        )}
      </aside>

      <section className="studio__stage">
        <header className="studio__topbar">
          <div className="stack grow">
            <h1 className="studio__title">{title}</h1>
            {subtitle && <span className="faint" style={{ fontSize: 'var(--t-small)' }}>{subtitle}</span>}
          </div>
          {!online && (
            <span className="hud__pill">
              <WifiOff size={16} color="var(--coral)" /> Нет сети
            </span>
          )}
          {actions}

          {/* Профиль всегда справа сверху — одинаково на обеих платформах. */}
          {user && (
            <button
              type="button"
              className="hud__avatar-btn"
              onClick={onOpenProfile}
              aria-label={`Профиль: ${user.displayName}`}
              aria-current={active === 'profile' ? 'page' : undefined}
            >
              {user.photoURL
                ? <img className="hud__avatar" src={user.photoURL} alt="" />
                : <span className="hud__avatar hud__avatar--empty">
                    {String(user.displayName ?? '?')[0]?.toUpperCase()}
                  </span>}
            </button>
          )}
        </header>

        {children}
      </section>
    </div>
  );
}
