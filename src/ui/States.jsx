import { useState } from 'react';
import { RefreshCw, WifiOff, X, ICON } from './icons.js';

/** Экран-состояние. Никогда не бесконечный спиннер — всегда текст и выход. */
export function EmptyState({ icon: Icon, title, text, action, art }) {
  return (
    <div className="state">
      {art
        ? <img className="state__art" src={art} alt="" />
        : Icon && <Icon size={32} color="var(--text-low)" />}
      {title && <h3 className="state__title">{title}</h3>}
      {text && <p className="state__text">{text}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ text = 'Собираем колоду…' }) {
  return (
    <div className="state">
      <div className="spinner" />
      <p className="state__text">{text}</p>
    </div>
  );
}

/**
 * Ошибка загрузки с кнопкой повтора. Отличает офлайн от сбоя сервиса —
 * пользователю это разные проблемы с разными действиями.
 */
export function ErrorState({ error, onRetry, module }) {
  const offline = error?.text?.includes('интернет') || !navigator.onLine;
  return (
    <div className="state">
      {offline
        ? <WifiOff size={44} color="var(--coral)" />
        : <RefreshCw size={44} color="var(--coral)" />}
      <h3 className="state__title">{offline ? 'Нет соединения' : 'Не получилось загрузить'}</h3>
      <p className="state__text">{error?.text ?? 'Попробуйте ещё раз.'}</p>
      {module && <span className="eyebrow">{module}</span>}
      {onRetry && error?.retryable !== false && (
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          <RefreshCw size={16} /> Повторить
        </button>
      )}
    </div>
  );
}

export function SkeletonGrid({ count = 9 }) {
  return (
    <div className="poster-grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ aspectRatio: '2 / 3', borderRadius: 'var(--r)' }} />
      ))}
    </div>
  );
}

/**
 * Строка состояния, которую можно закрыть.
 *
 * Уведомление о комнате висело постоянно и занимало строку на экране,
 * где каждая строка на счету, — а убрать его было нечем. Крестик решает
 * это, но состояние закрытия живёт ровно до следующего сообщения:
 * менять `dismissKey` достаточно, чтобы новое уведомление показалось,
 * даже если прошлое такое же было закрыто.
 *
 * @param {string} tone       'live' | 'warn' | 'error' | undefined
 * @param {object} [action]   { label, onClick } — если из уведомления
 *                            есть куда перейти, кнопка стоит рядом
 * @param {boolean} [dismissible] непреодолимые состояния (нет сети)
 *                            закрывать нечестно: проблема-то остаётся
 */
export function StatusStrip({ tone, action, dismissible = true, children }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  return (
    <div className={`status-strip ${tone ? `status-strip--${tone}` : ''}`} role="status">
      <span className="status-strip__text">{children}</span>

      {action && (
        <button type="button" className="status-strip__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}

      {dismissible && (
        <button
          type="button"
          className="status-strip__close"
          onClick={() => setHidden(true)}
          aria-label="Скрыть уведомление"
        >
          <X size={ICON.sm} />
        </button>
      )}
    </div>
  );
}
