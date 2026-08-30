import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, Check, Crown, Heart, Pencil, Star, UserPlus, UserRound } from '../../ui/icons.js';
import { EmptyState, ErrorState, LoadingState } from '../../ui/States.jsx';
import { Poster } from '../../ui/Poster.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { RatingBadge } from '../../ui/RatingPicker.jsx';
import { loadProfilePage, requestFriend, acceptFriend, removeFriend } from '../../engine/social.js';
import { tagLabel } from '../../../shared/taxonomy/tagOntology.js';
import { withPlural, FORMS } from '../../../shared/i18n/plural.js';

/**
 * Страница человека.
 *
 * Раньше здесь были имя, описание и четыре счётчика. Счётчики о человеке
 * не говорят ничего: «85 просмотрено» одинаково у того, кто любит хорроры,
 * и у того, кто смотрит только комедии. Смотреть было не на что.
 *
 * Теперь страница собрана из того, что человек уже решил: закреплённые
 * им фильмы, любимое, оценки, темы, накопившиеся по свайпам. Ничего
 * из этого не нужно заполнять отдельно — оно появляется само, пока
 * человек пользуется приложением.
 *
 * Первым делом — пересечение с тем, кто смотрит. Чужой профиль
 * открывают не с вопросом «кто это вообще», а с вопросом «а мы совпадём».
 */
export function PublicProfileView({
  username, userId, onBack, onOpenTitle, onEditShowcase, toasts,
  /** Нажатие на значок премиума открывает витрину подписки. */
  onOpenPremium,
}) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    // Из комнаты человек известен по идентификатору, из поиска — по нику.
    loadProfilePage({ username: userId ? null : username, userId })
      .then((person) => { if (alive) setState({ loading: false, person }); })
      .catch((error) => { if (alive) setState({ loading: false, error }); });
    return () => { alive = false; };
  }, [username, userId]);

  if (state.loading) return <LoadingState text="Открываем профиль…" />;
  if (state.error) {
    return <ErrorState error={{ text: 'Не удалось загрузить профиль', retryable: true }} module="social.profile" />;
  }

  /*
   * Кнопка появляется, только если возвращаться есть куда.
   *
   * На своей же странице (её открывает вкладка «Я») `onBack` не передан,
   * и «Назад» вело бы в никуда — а выглядело так, будто человек куда-то
   * провалился и должен выбираться.
   */
  const back = onBack ? (
    <button type="button" className="btn btn--quiet btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
      <ArrowLeft size={16} /> Назад
    </button>
  ) : null;

  if (!state.person) {
    return (
      <div className="view">
        {back}
        <EmptyState
          icon={UserRound}
          title="Профиль не найден"
          text={userId ? 'Этот человек ещё не заполнил профиль.' : `Ника @${username} не существует.`}
        />
      </div>
    );
  }

  const person = state.person;
  const {
    stats = {}, visibility = {}, pinned = [], favorites = [], topRated = [], tags = [], shared, hero,
  } = person;

  /*
   * Обложка — часть витрины, а витрина платная.
   *
   * Сервер уже вычистил `hero` и `pinned` у неоплаченных, но третьим
   * запасным вариантом здесь стояло «первое из любимого»: страница
   * всё равно оказывалась с картинкой, просто выбранной за человека.
   * Без подписки обложки нет вовсе — профиль серый по умолчанию.
   */
  const cover = person.premium ? (hero ?? pinned[0] ?? favorites[0] ?? null) : null;

  return (
    <div
      className="view profile-page"
      data-accent={person.accent ?? 'coral'}
      /* Фактура — премиальная часть оформления; у остальных `plain`. */
      data-frame={person.premium ? (person.frame ?? 'plain') : 'plain'}
    >
      {/*
        * Постер «фильма про себя» красит всю страницу, а не только шапку.
        *
        * Обложка в одной шапке читалась как случайная картинка сверху.
        * Растянутая на весь экран и уведённая в размытие, она перестаёт
        * быть картинкой и становится цветом страницы — тем самым, который
        * человек выбрал сам. Читаемость держит плотная подложка поверх:
        * без неё текст ложится на светлые куски постера.
        */}
      {cover?.poster && (
        <div className="profile-wash" aria-hidden="true">
          <Poster src={cover.poster} alt="" size="w500" rounded={false} />
        </div>
      )}

      {back}

      <header className="profile-hero">
        {cover?.poster && (
          <div className="profile-hero__cover" aria-hidden="true">
            <Poster src={cover.poster} alt="" size="w500" rounded={false} />
          </div>
        )}

        <div className="profile-hero__body">
          {person.photoURL
            ? <img className="profile-hero__avatar" src={person.photoURL} alt="" />
            : (
              <span className="profile-hero__avatar profile-hero__avatar--empty">
                <UserRound size={40} color="var(--text-low)" />
              </span>
            )}

          <h1 className="profile-hero__name">{person.displayName ?? person.username}</h1>
          {person.username && <span className="profile-hero__handle">@{person.username}</span>}
          {/*
            * Значок — половина смысла платной косметики: её ценность
            * в том, что её видно другим, а не владельцу.
            */}
          {/*
            * Значок нажимается и открывает витрину подписки.
            *
            * Человек, увидевший корону у друга, спрашивает «а что это?» —
            * и это лучший момент рассказать: интерес уже возник сам,
            * без нашей рекламы.
            */}
          {person.premium && (onOpenPremium ? (
            <button type="button" className="premium-badge premium-badge--link" onClick={onOpenPremium}>
              <Crown size={11} weight="fill" /> Премиум
            </button>
          ) : (
            <span className="premium-badge"><Crown size={11} weight="fill" /> Премиум</span>
          ))}
          {person.bio && <p className="profile-hero__bio">{person.bio}</p>}

          {hero?.title && (
            <p className="profile-hero__pick">
              Фильм про себя: <strong>«{hero.title}»</strong>
            </p>
          )}
        </div>
      </header>

      {/*
        * Пересечение стоит выше всего остального намеренно. Всё, что ниже, —
        * про человека вообще; эта строка — про вас двоих, и ради неё
        * в чужой профиль и заходят.
        */}
      {shared && (shared.count > 0 || shared.matches > 0) && (
        <section className="profile-block profile-block--shared">
          <h2 className="profile-block__title">
            <Check size={14} /> У вас общее
          </h2>
          <p className="profile-block__lead">
            {shared.count > 0 && <>{withPlural(shared.count, FORMS.MOVIE)} нравятся обоим</>}
            {shared.count > 0 && shared.matches > 0 && ' · '}
            {shared.matches > 0 && <>{withPlural(shared.matches, FORMS.MATCH)} в комнатах</>}
          </p>
          {shared.movies?.length > 0 && (
            <PosterRow items={shared.movies} onOpenTitle={onOpenTitle} />
          )}
        </section>
      )}

      {pinned.length > 0 && (
        <section className="profile-block">
          <h2 className="profile-block__title"><Bookmark size={14} /> Визитка</h2>
          <PosterRow items={pinned} onOpenTitle={onOpenTitle} large />
        </section>
      )}

      {tags.length > 0 && (
        <section className="profile-block">
          <h2 className="profile-block__title">Чаще всего смотрит</h2>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            {tags.map((tag) => (
              <span className="chip chip--on" key={tag}>{tagLabel(tag)}</span>
            ))}
          </div>
        </section>
      )}

      {visibility.films !== false && favorites.length > 0 && (
        <section className="profile-block">
          <h2 className="profile-block__title"><Heart size={14} /> Любимое</h2>
          <PosterRow items={favorites} onOpenTitle={onOpenTitle} />
        </section>
      )}

      {visibility.ratings !== false && topRated.length > 0 && (
        <section className="profile-block">
          <h2 className="profile-block__title"><Star size={14} /> Оценил выше всего</h2>
          <div className="poster-grid">
            {topRated.map((item) => (
              <button type="button" className="poster-card" key={item.id} onClick={() => onOpenTitle?.(item)}>
                <Poster src={item.poster} alt={item.title} size="w342" />
                <span className="poster-card__cap truncate">{item.title}</span>
                <RatingBadge value={item.userRating} className="poster-card__rating" />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="profile-block">
        <div className="stat-row" style={{ width: '100%' }}>
          <Stat value={stats.favorites} label="любимых" />
          {stats.watched !== null && stats.watched !== undefined && (
            <Stat value={stats.watched} label="просмотрено" />
          )}
          {stats.ratings ? <Stat value={stats.ratings} label="оценок" /> : null}
          {stats.averageRating !== null && stats.averageRating !== undefined && (
            <Stat value={stats.averageRating} label="средняя" gold />
          )}
          {stats.matches ? <Stat value={stats.matches} label="мэтчей" /> : null}
        </div>
        {person.createdAt && (
          <p className="faint" style={{ fontSize: 'var(--t-small)', textAlign: 'center' }}>
            Здесь с {since(person.createdAt)}
            {stats.decisions ? ` · ${withPlural(stats.decisions, FORMS.DECISION)}` : ''}
          </p>
        )}
      </section>

      {/*
        * Пустой профиль честнее объяснить, чем показать пустые полки:
        * человек мог только зарегистрироваться, а мог и закрыть фильмы.
        */}
      {!pinned.length && !favorites.length && !topRated.length && (
        <EmptyState
          icon={UserRound}
          title={visibility.films === false ? 'Фильмы скрыты' : 'Пока пусто'}
          text={visibility.films === false
            ? 'Человек не показывает свои списки — только имя и общую статистику.'
            : 'Человек ещё ничего не отметил любимым. Загляните позже.'}
        />
      )}

      {person.isMe ? (
        <button type="button" className="btn btn--ghost" onClick={onEditShowcase}>
          <Pencil size={16} /> Настроить витрину
        </button>
      ) : (
        <FriendButton person={person} toasts={toasts} />
      )}
    </div>
  );
}

/**
 * Кнопка дружбы — четыре состояния, а не два.
 *
 * Раньше она всегда предлагала «добавить в друзья», в том числе тем,
 * кто уже друзья: заявка уходила в никуда, а человек жал ещё раз,
 * решив, что не отправилось. Состояние приходит со страницей
 * (`person.friendship`) и считается на сервере глазами того, кто смотрит.
 *
 * «Заявка от него» отделена от «заявки от меня» намеренно: в первом
 * случае нужно принять, во втором — ждать, и одна кнопка на оба случая
 * врёт в одном из них.
 *
 * Удаление спрашивает подтверждения. Дружба здесь — не подписка,
 * которую вернёшь одним касанием: обратно её придётся просить.
 */
function FriendButton({ person, toasts }) {
  const [state, setState] = useState(person.friendship ?? 'none');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /* Открыли другого человека — состояние обязано начаться заново. */
  useEffect(() => { setState(person.friendship ?? 'none'); }, [person.id, person.friendship]);

  const run = async (fn, done, fail) => {
    setBusy(true);
    try {
      const result = await fn();
      done(result);
    } catch (error) {
      toasts?.error(error?.message ?? fail);
    } finally {
      setBusy(false);
    }
  };

  if (state === 'friends') {
    const name = person.displayName ?? person.username ?? 'этого человека';
    return (
      <>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Check size={16} /> Уже в друзьях
        </button>

        {/*
          * Своя шторка, а не системный `confirm`.
          *
          * В Telegram WebView системные диалоги заблокированы: `confirm`
          * молча возвращает false, и кнопка выглядела бы живой, ничего
          * не делая. Подтверждение при этом обязательно — кнопка стоит
          * там же, где раньше стояло «добавить», и промах стоил бы дружбы.
          */}
        <Sheet
          open={confirming}
          onClose={() => setConfirming(false)}
          variant="center"
          title={`Удалить ${name} из друзей?`}
        >
          <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
            Общие списки и совпадения никуда не денутся. Но чтобы вернуть
            дружбу, заявку придётся отправлять заново.
          </p>

          <div className="row gap-3" style={{ marginTop: 'var(--s-5)' }}>
            <button
              type="button"
              className="btn btn--danger-solid grow"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                run(() => removeFriend(person.id),
                  () => { setState('none'); toasts?.push('Удалили из друзей'); },
                  'Не получилось удалить');
              }}
            >
              Удалить
            </button>
            <button type="button" className="btn btn--ghost grow" onClick={() => setConfirming(false)}>
              Отмена
            </button>
          </div>
        </Sheet>
      </>
    );
  }

  if (state === 'incoming') {
    return (
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={() => run(() => acceptFriend(person.id),
          () => { setState('friends'); toasts?.success('Теперь вы друзья'); },
          'Не получилось принять заявку')}
      >
        <UserPlus size={16} /> Принять заявку
      </button>
    );
  }

  if (state === 'sent') {
    return (
      <button type="button" className="btn btn--ghost" disabled>
        <UserPlus size={16} /> Заявка отправлена
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn--primary"
      disabled={busy}
      onClick={() => run(() => requestFriend(person.id),
        (status) => {
          setState(status === 'accepted' ? 'friends' : 'sent');
          toasts?.success(status === 'accepted' ? 'Теперь вы друзья' : 'Заявка отправлена');
        },
        'Не получилось отправить заявку')}
    >
      <UserPlus size={16} /> Добавить в друзья
    </button>
  );
}

/**
 * Ряд постеров с горизонтальной прокруткой.
 *
 * Именно ряд, а не сетка: сетка на восемнадцать фильмов занимает
 * несколько экранов и выталкивает вниз всё остальное, а ряд читается
 * одним движением и оставляет странице ритм.
 */
function PosterRow({ items, onOpenTitle, large = false }) {
  return (
    <div className={`poster-row ${large ? 'poster-row--large' : ''}`}>
      {items.map((item, index) => (
        <button
          type="button"
          className="poster-row__item"
          key={`${item.id ?? item.title}-${index}`}
          onClick={() => onOpenTitle?.(item)}
          title={item.title}
        >
          <Poster src={item.poster} alt={item.title} size="w342" />
          <span className="poster-row__cap truncate">{item.title}</span>
        </button>
      ))}
    </div>
  );
}

/*
 * «Здесь с августа», а не «здесь с август».
 *
 * Штатный форматтер даёт месяц в именительном падеже, и фраза ломается
 * на ровном месте. Названия проще перечислить, чем выкручивать локаль.
 */
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function since(iso) {
  const date = new Date(iso);
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function Stat({ value, label, gold = false }) {
  return (
    <div className="stat">
      <span className="stat__value" style={gold ? { color: 'var(--gold)' } : undefined}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}
