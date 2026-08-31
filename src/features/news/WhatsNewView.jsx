import { ArrowLeft, Crown, Send, Sparkles, Wrench } from '../../ui/icons.js';
import { NEWS_TAG, NEWS_TAG_LABEL, newsByRelease } from '../../../shared/config/news.js';
import { PREMIUM_CONFIG } from '../../../shared/config/premium.js';

/** Списки, на которые ссылаются записи. Один источник с витриной подписки. */
const LISTS = { premium: PREMIUM_CONFIG.benefits };

const ICONS = {
  [NEWS_TAG.PREMIUM]: Crown,
  [NEWS_TAG.FEATURE]: Sparkles,
  [NEWS_TAG.FIX]: Wrench,
};

/**
 * Что нового — история продукта.
 *
 * Записи идут в порядке файла, а не по убыванию даты: сортировка
 * по строке даты означала бы, что опечатка в ней молча перемешивает
 * историю. Порядок задаёт тот, кто пишет.
 *
 * Текст написан от пользы, а не от изменений: «оценка сразу после
 * просмотра», а не «добавлен компонент RateAsk». Список коммитов
 * человеку не говорит ничего, и читать его он не будет.
 */
export function WhatsNewView({ onBack, onOpenPremium, onOpenFeedback }) {
  return (
    <div className="view">
      <header className="view__head">
        <div className="row gap-3" style={{ alignItems: 'center' }}>
          {onBack && (
            <button type="button" className="action action--sm" aria-label="Назад" onClick={onBack}>
              <ArrowLeft size={18} />
            </button>
          )}
          <h1 className="view__title">Дневник разработки</h1>
        </div>
        <p className="view__sub">
          Пишем сюда о каждом заметном изменении — что сделали и почему именно так.
        </p>
      </header>

      {/*
        * Статьи сгруппированы по выпуску, а не свалены в один поток:
        * иначе не видно, что вышло вместе, — а для дневника это половина
        * смысла.
        */}
      {newsByRelease().map((group) => (
        <section className="news-release" key={group.release ?? 'прочее'}>
          {group.release && (
            <h2 className="news-release__title">{group.release}</h2>
          )}

          <div className="news-list">
            {group.items.map((item) => {
              const Icon = ICONS[item.tag] ?? Sparkles;
              return (
                <article className="news-entry" key={item.id} data-tag={item.tag}>
                  <div className="news-entry__head">
                    <span className="news-entry__tag">
                      <Icon size={12} weight="fill" /> {NEWS_TAG_LABEL[item.tag] ?? 'Новое'}
                    </span>
                    <time className="news-entry__date" dateTime={item.date}>
                      {new Date(item.date).toLocaleDateString('ru-RU', {
                        day: 'numeric', month: 'long', year: 'numeric',
                      })}
                    </time>
                  </div>

                  <h3 className="news-entry__title">{item.title}</h3>

                  {item.body.map((paragraph) => (
                    <p className="news-entry__text" key={paragraph.slice(0, 40)}>{paragraph}</p>
                  ))}

                  {LISTS[item.listFrom] && (
                    <ul className="news-entry__list">
                      {LISTS[item.listFrom].map((benefit) => (
                        <li key={benefit}>{benefit}</li>
                      ))}
                    </ul>
                  )}

                  {item.tail?.map((paragraph) => (
                    <p className="news-entry__text" key={paragraph.slice(0, 40)}>{paragraph}</p>
                  ))}

                  {item.action === 'premium' && onOpenPremium && (
                    <button type="button" className="btn btn--gold" onClick={onOpenPremium}>
                      <Crown size={15} weight="fill" /> Посмотреть премиум
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {/*
        * Приглашение написать заканчивается кнопкой, а не призывом.
        * «Напишите нам» без способа написать — просьба, за которую
        * человеку самому искать, куда идти.
        */}
      <div className="stack gap-3" style={{ textAlign: 'center' }}>
        <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
          Есть что сказать про обновление? На этой стадии каждый отзыв
          меняет продукт заметно сильнее, чем потом.
        </p>
        {onOpenFeedback && (
          <button type="button" className="btn btn--ghost" onClick={onOpenFeedback}>
            <Send size={15} /> Написать нам
          </button>
        )}
      </div>
    </div>
  );
}
