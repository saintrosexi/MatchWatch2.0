import { useState } from 'react';
import { ProfileView } from './ProfileView.jsx';
import { FriendsView } from '../friends/FriendsView.jsx';

/**
 * Раздел «Я»: профиль и друзья под одной вкладкой.
 *
 * Раньше это были два пункта навигации — «Друзья» внизу и аватар в шапке.
 * Аватар в шапке в Mini App попадал прямо под кнопки Telegram и просто
 * не нажимался, а разносить «кто я» и «с кем я смотрю» по разным углам
 * экрана незачем: это один и тот же разговор о себе.
 */
const TABS = [
  { key: 'profile', label: 'Мой профиль' },
  { key: 'friends', label: 'Друзья' },
];

export function MeView({
  initialTab = 'profile', onOpenPublicProfile, showTabs = true, ...rest
}) {
  const [tab, setTab] = useState(initialTab);

  return (
    <div className="me">
      {/*
        * На большом экране профиль и друзья — два пункта бокового меню,
        * и переключатель здесь повторял бы навигацию.
        */}
      {showTabs && (
      <div className="segmented" role="tablist" aria-label="Раздел «Я»">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            className="segmented__item"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      )}

      {tab === 'profile'
        ? <ProfileView {...rest} onOpenFriends={() => setTab('friends')} />
        : (
          <FriendsView
            me={rest.user}
            toasts={rest.toasts}
            onOpenProfile={onOpenPublicProfile}
            onOpenTitle={rest.onOpenTitle}
          />
        )}
    </div>
  );
}
