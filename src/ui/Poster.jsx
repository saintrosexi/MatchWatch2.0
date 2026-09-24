import { useEffect, useRef, useState } from 'react';
import { Film } from './icons.js';
import { isSlowConnection } from '../lib/network.js';

/** Переключение размера постера TMDB без повторного запроса к API. */
export function posterVariant(url, size) {
  if (!url) return null;
  return url.replace(/\/(w\d+|h\d+|original)\//, `/${size}/`);
}

/**
 * Постер с ленивой загрузкой, размером под скорость сети и внятной
 * заглушкой. На медленном соединении карточки не должны тормозить ленту,
 * поэтому там сознательно берётся вариант меньшего разрешения.
 */
export function Poster({
  src, alt, size = 'w500', eager = false, className = '', rounded = true, onLoad,
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef(null);

  const effectiveSize = isSlowConnection() && size === 'w500' ? 'w342' : size;
  const url = posterVariant(src, effectiveSize);

  useEffect(() => { setLoaded(false); setFailed(false); }, [url]);

  // Уже закэшированная браузером картинка не выстрелит onLoad, если
  // компонент смонтировался после декодирования — проверяем вручную.
  useEffect(() => {
    if (ref.current?.complete && ref.current.naturalWidth > 0) setLoaded(true);
  }, [url]);

  if (!url || failed) {
    return (
      <div className={`poster-fallback ${className}`} style={fallbackStyle(rounded)} aria-label={alt}>
        <Film size={26} color="var(--text-faint)" />
        <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-low)', padding: '0 8px' }}>
          {alt || 'Постер недоступен'}
        </span>
      </div>
    );
  }

  return (
    <img
      ref={ref}
      className={className}
      src={url}
      alt={alt}
      data-loaded={loaded}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={eager ? 'high' : 'auto'}
      draggable={false}
      onLoad={() => { setLoaded(true); onLoad?.(); }}
      onError={() => setFailed(true)}
    />
  );
}

const fallbackStyle = (rounded) => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
  height: '100%',
  background: 'var(--ink-800)',
  borderRadius: rounded ? 'inherit' : 0,
});

/** Предзагрузка ближайших постеров — карточка не должна «проявляться». */
export function prefetchPosters(urls, size = 'w500') {
  for (const url of urls.filter(Boolean).slice(0, 6)) {
    const img = new Image();
    img.decoding = 'async';
    img.src = posterVariant(url, isSlowConnection() ? 'w342' : size);
  }
}
