import { useEffect, useState } from 'react';
import { Clapperboard, Star } from '../../ui/icons.js';
import { CatalogBrowser } from './CatalogBrowser.jsx';
import { StarHubView } from '../stars/StarHubView.jsx';
import { useGlassLens } from '../../ui/useGlassLens.js';

const SECTIONS = [
  { key: 'catalog', label: 'Каталог', icon: Clapperboard },
  { key: 'stars', label: 'Звёзды', icon: Star },
];

/**
 * «Каталог» — два способа найти новое кино, кроме свайпа:
 * весь TMDB с фильтрами и вход через актёра.
 *
 * То, про что решение уже принято, живёт в отдельном разделе «Моё»:
 * искать новое и перебирать выбранное — разные задачи, смешивать их
 * в одной вкладке значило заставлять переключаться туда-обратно.
 */
export function CollectionView({ catalog, stars, initialSection = 'catalog', showTabs = true }) {
  const [section, setSection] = useState(initialSection);
  const lens = useGlassLens(SECTIONS.findIndex((s) => s.key === section), SECTIONS.length);

  // Переход из карточки фильма к актёру должен сразу открывать звёзды.
  useEffect(() => {
    if (stars.initialPersonId) setSection('stars');
  }, [stars.initialPersonId]);

  return (
    <div className="stack">
      {/*
        * На большом экране каталог и актёры — два пункта бокового меню,
        * и переключатель здесь дублировал бы навигацию.
        */}
      {showTabs && (
      <div className="segmented segmented--capped" role="tablist" aria-label="Раздел коллекции" {...lens}>
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            className="segmented__item"
            onClick={() => setSection(key)}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>
      )}

      {section === 'catalog' && <CatalogBrowser {...catalog} />}
      {section === 'stars' && <StarHubView {...stars} embedded />}
    </div>
  );
}
