import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Check, Heart, Lock, Star } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Poster } from '../../ui/Poster.jsx';
import { EmptyState } from '../../ui/States.jsx';
import { saveShowcase } from '../../engine/social.js';
import { accentAllowed, frameAllowed, pinLimitFor } from '../../../shared/config/premium.js';

/** Палитра продукта. Произвольный цвет рано или поздно нечитаем на тёмном. */
const ACCENTS = [
  { key: 'coral', label: 'Коралловый', color: 'var(--coral)' },
  { key: 'gold', label: 'Золотой', color: 'var(--gold)' },
  { key: 'ice', label: 'Ледяной', color: 'var(--ice)' },
  { key: 'mint', label: 'Мятный', color: 'var(--mint)' },
  { key: 'violet', label: 'Фиолетовый', color: '#a97bff' },
  { key: 'ember', label: 'Уголь', color: '#ff7a3d' },
  { key: 'ocean', label: 'Океан', color: '#3da5ff' },
  { key: 'orchid', label: 'Орхидея', color: '#e86fd6' },
  { key: 'moss', label: 'Мох', color: '#8fbf52' },
];

/**
 * Фактура карточки профиля.
 *
 * Отдельно от цвета намеренно: человек выбирает то и другое независимо,
 * и любая пара обязана выглядеть намеренной. Пар «цвет + фактура»
 * заранее мы не собираем — это был бы выбор из девяти готовых образов
 * вместо выбора из девяти цветов и пяти фактур.
 */
const FRAMES = [
  { key: 'plain', label: 'Без фактуры' },
  { key: 'glow', label: 'Свечение' },
  { key: 'gradient', label: 'Градиент' },
  { key: 'film', label: 'Плёнка' },
  { key: 'noir', label: 'Нуар' },
];

/**
 * Витрина профиля: что человек показывает о себе и как это выглядит.
 *
 * Здесь нет ни одного поля вида «расскажите о себе». Всё, из чего
 * собирается страница, человек уже отметил, пока пользовался лентой, —
 * настроить можно только порядок и видимость. Так профиль не пустует
 * у тех, кто не любит заполнять анкеты, а таких большинство.
 */
export function ShowcaseEditor({
  open, onClose, uid, profile, favorites = {}, onSaved, toasts,
  premium = false, onOpenPremium,
}) {
  const [form, setForm] = useState({
    pinnedIds: [], heroId: null, accent: 'coral', frame: 'plain',
    showFilms: true, showRatings: true, showWatched: true,
  });
  const [saving, setSaving] = useState(false);

  /* Потолок визитки — из конфига подписки, а не из константы файла. */
  const pinLimit = pinLimitFor({ premium });

  /*
   * Закреплённые в порядке закрепления — они же кандидаты в обложку.
   * Порядок сохраняем: он и есть порядок визитки на странице.
   */
  const heroOptions = useMemo(
    () => form.pinnedIds.map((id) => options.find((o) => o.id === id)).filter(Boolean),
    [form.pinnedIds, options],
  );

  useEffect(() => {
    if (!open) return;
    setForm({
      pinnedIds: profile?.pinned_ids ?? [],
      heroId: profile?.hero_id ?? null,
      accent: profile?.accent ?? 'coral',
      frame: profile?.frame ?? 'plain',
      showFilms: profile?.show_films ?? true,
      showRatings: profile?.show_ratings ?? true,
      showWatched: profile?.show_watched ?? true,
    });
  }, [open, profile]);

  /*
   * Выбирать можно только из любимого. Это и есть смысл визитки:
   * не «любой фильм из каталога», а «вот эти из тех, что я уже назвал
   * своими». Иначе закреплённое перестаёт что-либо значить.
   */
  const options = useMemo(
    () => Object.values(favorites).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)),
    [favorites],
  );

  const togglePin = (id) => setForm((f) => {
    if (f.pinnedIds.includes(id)) {
      /*
       * Открепили фильм, который был обложкой, — обложку тоже снимаем.
       * Иначе страница осталась бы с постером фильма, которого на ней
       * уже нет, и объяснить это было бы нечем.
       */
      const heroId = f.heroId === id ? null : f.heroId;
      return { ...f, heroId, pinnedIds: f.pinnedIds.filter((x) => x !== id) };
    }
    if (f.pinnedIds.length >= pinLimit) return f;
    return { ...f, pinnedIds: [...f.pinnedIds, id] };
  });

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = await saveShowcase(uid, { ...form, pinLimit });
      onSaved?.(saved);
      toasts?.success('Профиль обновлён');
      onClose?.();
    } catch (error) {
      toasts?.error(error?.message ?? 'Не получилось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Витрина профиля">
      <form className="stack gap-5" onSubmit={submit}>
        <section className="stack gap-3">
          <span className="field__label">Цвет страницы</span>
          <div className="row gap-3" style={{ flexWrap: 'wrap' }}>
            {ACCENTS.map((item) => {
              const locked = !accentAllowed(item.key, { premium });
              return (
                <button
                  type="button"
                  key={item.key}
                  className={`accent-dot ${form.accent === item.key ? 'accent-dot--on' : ''} ${locked ? 'accent-dot--locked' : ''}`}
                  style={{ '--dot': item.color }}
                  aria-label={locked ? `${item.label} — в премиуме` : item.label}
                  aria-pressed={form.accent === item.key}
                  /*
                   * Закрытый цвет не прячем, а показываем запертым:
                   * спрятанное невозможно захотеть, а витрину открывает
                   * именно желание, а не строка в списке выгод.
                   */
                  onClick={() => (locked
                    ? onOpenPremium?.()
                    : setForm((f) => ({ ...f, accent: item.key })))}
                >
                  {locked ? <Lock size={12} /> : (form.accent === item.key && <Check size={14} />)}
                </button>
              );
            })}
          </div>
        </section>

        <section className="stack gap-3">
          <span className="field__label">Фактура карточки</span>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            {FRAMES.map((item) => {
              const locked = !frameAllowed(item.key, { premium });
              const on = form.frame === item.key;
              return (
                <button
                  type="button"
                  key={item.key}
                  className={`chip chip--interactive ${on ? 'chip--on' : ''}`}
                  aria-pressed={on}
                  onClick={() => (locked
                    ? onOpenPremium?.()
                    : setForm((f) => ({ ...f, frame: item.key })))}
                >
                  {locked && <Lock size={11} />} {item.label}
                </button>
              );
            })}
          </div>
        </section>

        {options.length === 0 ? (
          <EmptyState
            icon={Heart}
            title="Сначала отметьте любимое"
            text="Визитка собирается из фильмов, которым вы поставили сердечко. Отметьте несколько — и они появятся здесь."
          />
        ) : (
          <>
            <section className="stack gap-3">
              <span className="field__label">
                <Bookmark size={14} /> Визитка — до {pinLimit} фильмов
              </span>
              <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                Их увидят первыми. Выбрано {form.pinnedIds.length} из {pinLimit}.
              </p>
              <div className="pick-grid">
                {options.map((item) => {
                  const on = form.pinnedIds.includes(item.id);
                  const order = form.pinnedIds.indexOf(item.id) + 1;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={`pick-card ${on ? 'pick-card--on' : ''}`}
                      aria-pressed={on}
                      onClick={() => togglePin(item.id)}
                      title={item.title}
                    >
                      <Poster src={item.poster} alt={item.title} size="w185" />
                      {on && <span className="pick-card__badge">{order}</span>}
                      <span className="pick-card__cap truncate">{item.title}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="stack gap-3">
              <span className="field__label"><Star size={14} /> Фильм про себя</span>
              <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                Выбирается из закреплённых выше. Его постер станет обложкой страницы.
              </p>

              {/*
                * Выбор идёт из ВИТРИНЫ, а не из всего любимого.
                *
                * Раньше здесь лежали первые двенадцать любимых, и обложкой
                * оказывался фильм, которого на странице нет: человек видел
                * постер и не находил, откуда он взялся. Теперь список один:
                * что закрепил — из того и выбираешь.
                */}
              {heroOptions.length === 0 ? (
                <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
                  Закрепите фильм выше — и его можно будет сделать обложкой.
                </p>
              ) : (
                <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`chip chip--interactive ${!form.heroId ? 'chip--on' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, heroId: null }))}
                  >
                    без обложки
                  </button>
                  {heroOptions.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`chip chip--interactive ${form.heroId === item.id ? 'chip--on' : ''}`}
                      onClick={() => setForm((f) => ({ ...f, heroId: item.id }))}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <section className="stack gap-3">
          <span className="field__label">Что видно другим</span>
          {/*
            * Открыто по умолчанию, но каждый раздел закрывается отдельно.
            * Скрытые фильмы прячут и совпадение по ним: иначе закрытый
            * список вычерпывался бы по одному фильму через сравнение.
            */}
          <Toggle
            label="Любимые фильмы"
            hint="Витрина, любимое и совпадение с другими"
            value={form.showFilms}
            onChange={(v) => setForm((f) => ({ ...f, showFilms: v }))}
          />
          <Toggle
            label="Оценки"
            hint="Что оценил выше всего и средний балл"
            value={form.showRatings}
            onChange={(v) => setForm((f) => ({ ...f, showRatings: v }))}
          />
          <Toggle
            label="Сколько просмотрено"
            hint="Только число, без списка"
            value={form.showWatched}
            onChange={(v) => setForm((f) => ({ ...f, showWatched: v }))}
          />
        </section>

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={saving}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </form>
    </Sheet>
  );
}

/* Тот же переключатель, что в настройках профиля: одинаковые вещи
   не должны выглядеть по-разному от экрана к экрану. */
function Toggle({ label, hint, value, onChange }) {
  return (
    <label className="member" style={{ cursor: 'pointer' }}>
      <span className="stack grow">
        <span className="member__name">{label}</span>
        <span className="member__state">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 20, height: 20, accentColor: 'var(--coral)' }}
      />
    </label>
  );
}
