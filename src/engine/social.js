/**
 * Социальный слой: публичный профиль, поиск людей, друзья.
 *
 * Вся логика доступа живёт в SQL-функциях: клиент не должен уметь
 * читать чужие профили напрямую, иначе анон-ключом можно вычерпать
 * базу пользователей. Здесь только вызовы и приведение форм.
 */

import { supabase, supabaseReady, guarded } from '../lib/supabase.js';
import { ENV } from '../lib/env.js';
import { trackMetric } from '../lib/telemetry.js';
import { MODULE } from '../../shared/telemetry/events.js';

const shapePerson = (row) => (row ? {
  id: row.id,
  username: row.username,
  displayName: row.display_name ?? row.username,
  photoURL: row.photo_url,
  bio: row.bio,
  status: row.status,
  requestedBy: row.requested_by,
} : null);

/** Свободен ли ник. Форма спрашивает до отправки, а не ловит отказ после. */
export async function isUsernameAvailable(username) {
  if (!supabaseReady() || !username) return false;
  const { data, error } = await supabase.rpc('username_available', { p_username: username });
  if (error) return false;
  return Boolean(data);
}

/** Сохраняет то, что человек показывает о себе. */
export async function saveProfile(uid, { displayName, username, bio, photoURL }) {
  if (!supabaseReady() || !uid) return null;

  const patch = {};
  if (displayName !== undefined) patch.display_name = displayName?.trim() || null;
  if (username !== undefined) patch.username = username?.trim().toLowerCase() || null;
  if (bio !== undefined) patch.bio = bio?.trim() || null;
  if (photoURL !== undefined) patch.photo_url = photoURL || null;

  const { data, error } = await supabase
    .from('profiles').update(patch).eq('id', uid).select().maybeSingle();

  if (error) {
    // Уникальный индекс — единственный надёжный арбитр: проверка «свободен ли»
    // могла устареть за те секунды, что человек заполнял форму.
    if (error.code === '23505') {
      throw Object.assign(new Error('Такой ник уже занят'), { code: 'username_taken' });
    }
    if (error.code === '23514') {
      throw Object.assign(new Error('Ник: 3–24 символа, латиница, цифры, точка и подчёркивание'), { code: 'username_invalid' });
    }
    throw error;
  }
  return data;
}

/**
 * Страница профиля целиком — одним запросом.
 *
 * Раньше профиль отдавал имя, описание и четыре счётчика; смотреть там
 * было не на что. Теперь это страница человека: закреплённые фильмы,
 * любимое, оценки, темы вкуса — и пересечение с тем, кто смотрит.
 *
 * Собирается на стороне базы намеренно. Шесть отдельных запросов
 * означали бы шесть ожиданий подряд при открытии экрана, а решает
 * здесь именно скорость: профиль открывают мимоходом, из комнаты
 * или из списка друзей.
 */
export async function loadProfilePage({ username = null, userId = null } = {}) {
  if (!supabaseReady() || (!username && !userId)) return null;
  const { data, error } = await supabase.rpc('profile_page', {
    p_username: username,
    p_user: userId,
  });
  if (error) throw error;
  return data ?? null;
}

/**
 * Витрина профиля: что человек показывает и как это выглядит.
 *
 * Отдельно от `saveProfile` — там имя и ник, то есть кто человек такой,
 * а здесь то, что он о себе показывает. Смешивать их значит на каждое
 * переключение тумблера перепроверять занятость ника.
 */
export async function saveShowcase(uid, {
  pinnedIds, heroId, accent, frame, showFilms, showRatings, showWatched,
  /*
   * Потолок визитки приходит от вызывающего, а не берётся здесь
   * константой: он зависит от подписки. Обрезка тут — только защита
   * от случайного лишнего, настоящий предел проверяет база
   * (`cardinality(pinned_ids) <= pin_limit`).
   */
  pinLimit = 6,
}) {
  if (!supabaseReady() || !uid) return null;

  const patch = {};
  if (pinnedIds !== undefined) patch.pinned_ids = pinnedIds.slice(0, pinLimit);
  if (heroId !== undefined) patch.hero_id = heroId || null;
  if (accent !== undefined) patch.accent = accent;
  if (frame !== undefined) patch.frame = frame;
  if (showFilms !== undefined) patch.show_films = showFilms;
  if (showRatings !== undefined) patch.show_ratings = showRatings;
  if (showWatched !== undefined) patch.show_watched = showWatched;
  if (!Object.keys(patch).length) return null;

  const { data, error } = await supabase
    .from('profiles').update(patch).eq('id', uid).select().maybeSingle();
  if (error) throw error;
  trackMetric('profile_showcase_saved', { context: { fields: Object.keys(patch).join(',') } });
  return data;
}

/** Публичная карточка по нику. */
export async function loadPublicProfile(username) {
  if (!supabaseReady() || !username) return null;
  const { data, error } = await supabase.rpc('public_profile', { p_username: username });
  if (error) throw error;
  const row = (data ?? [])[0];
  if (!row) return null;
  return {
    ...shapePerson(row),
    createdAt: row.created_at,
    stats: {
      ratings: Number(row.ratings_count ?? 0),
      averageRating: row.average_rating === null ? null : Number(row.average_rating),
      favorites: Number(row.favorites_count ?? 0),
      watched: Number(row.watched_count ?? 0),
    },
  };
}

/** Поиск людей: по началу ника или по точному адресу почты. */
export async function searchPeople(query) {
  // Порог тот же, что в SQL: перебор алфавита по одной букве выгрузил бы
  // список всех, кто завёл ник.
  if (!supabaseReady() || !query || query.trim().length < 3) return [];
  const { data, error } = await supabase.rpc('search_users', { p_query: query.trim() });
  if (error) throw error;
  return (data ?? []).map(shapePerson);
}

export async function loadFriends() {
  if (!supabaseReady()) return [];
  const { data, error } = await supabase.rpc('my_friends');
  if (error) throw error;
  return (data ?? []).map(shapePerson);
}

/**
 * Кого посоветовать в друзья — по пересечению любимого.
 *
 * Считает сервер: у него есть чужое избранное, у клиента его нет
 * и быть не должно. Возвращает уже отфильтрованных — тех, с кем
 * человек ещё не в друзьях и кому есть что показать.
 */
export async function loadSuggestedFriends(limit = 12) {
  if (!supabaseReady()) return [];
  const { data, error } = await supabase.rpc('suggested_friends', { p_limit: limit });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...shapePerson(row),
    /* Сколько любимых совпало — это и есть причина показать человека. */
    shared: Number(row.shared_count ?? 0),
  }));
}

/**
 * Отправляет отзыв.
 *
 * Контекст собираем сами — экран, версия, платформа. Спрашивать это
 * у человека значит превращать отзыв в форму, а формы не заполняют:
 * пишут тогда, когда написать можно в одно поле и в одну кнопку.
 */
/**
 * Запускал ли человек бота.
 *
 * От этого зависит, дойдёт ли до него хоть одно уведомление: Telegram
 * не даёт писать первым, а Mini App открывается мимо чата с ботом.
 */
export async function isBotStarted() {
  /*
   * Три исхода, а не два: да, нет и «не знаем».
   *
   * Раньше при любом сбое возвращалось `true` — «бот запущен». Полоса
   * с предупреждением исчезала, и человек считал, что уведомления
   * работают, хотя мы этого не проверили. Ошибка сети превращалась
   * в утверждение о доставке.
   *
   * `null` означает незнание. Молчать по незнанию правильно — пугать
   * зря хуже, — но выдавать незнание за подтверждение нельзя.
   */
  if (!supabaseReady()) return null;
  const { data, error } = await supabase.rpc('bot_started');
  if (error) return null;
  return Boolean(data);
}

export async function sendFeedback(body, { uid, screen } = {}) {
  const text = String(body ?? '').trim().slice(0, 2000);
  if (!supabaseReady() || !uid || text.length < 2) return false;

  const { error } = await supabase.from('feedback').insert({
    user_id: uid,
    body: text,
    context: {
      screen: screen ?? null,
      release: ENV.release,
      platform: globalThis.Telegram?.WebApp?.platform ?? 'web',
    },
  });

  if (error) throw error;
  trackMetric('feedback_sent', { context: { screen: screen ?? null } });
  return true;
}

export async function requestFriend(friendId) {
  const status = await guarded(
    () => supabase.rpc('request_friend', { p_friend: friendId }),
    { module: MODULE.ROOMS_JOIN, description: 'request friend' },
  );
  trackMetric('friend_request_sent', { context: { status } });
  return status;
}

export const acceptFriend = (friendId) => guarded(
  () => supabase.rpc('accept_friend', { p_friend: friendId }),
  { module: MODULE.ROOMS_JOIN, description: 'accept friend' },
);

export const removeFriend = (friendId) => guarded(
  () => supabase.rpc('remove_friend', { p_friend: friendId }),
  { module: MODULE.ROOMS_JOIN, description: 'remove friend' },
);

/**
 * Публичная карточка по идентификатору.
 *
 * Участник комнаты известен по user_id, а не по нику — открыть его
 * профиль иначе нечем.
 */
export async function loadPublicProfileById(userId) {
  if (!supabaseReady() || !userId) return null;
  const { data, error } = await supabase.rpc('public_profile_by_id', { p_user: userId });
  if (error) throw error;
  const row = (data ?? [])[0];
  if (!row) return null;
  return {
    ...shapePerson(row),
    createdAt: row.created_at,
    stats: {
      ratings: Number(row.ratings_count ?? 0),
      averageRating: row.average_rating === null ? null : Number(row.average_rating),
      favorites: Number(row.favorites_count ?? 0),
      watched: Number(row.watched_count ?? 0),
    },
  };
}

/**
 * Что вы оба собираетесь посмотреть.
 *
 * Отдаётся только пересечение и только для подтверждённой дружбы: чужой
 * список целиком — это чужие планы на вечер, а пересечение обе стороны
 * и так собирались обсуждать.
 */
export async function loadSharedWatchlist(friendId) {
  if (!supabaseReady() || !friendId) return [];
  const { data, error } = await supabase.rpc('shared_watchlist', { p_friend: friendId });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...(row.title ?? {}),
    id: row.title_id,
    mineAt: row.mine_at ? new Date(row.mine_at).getTime() : null,
    theirsAt: row.theirs_at ? new Date(row.theirs_at).getTime() : null,
  }));
}

/** Что принимаем: браузер отдаёт mime, и по нему же фильтрует диалог выбора. */
export const AVATAR_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Загрузка аватара.
 *
 * Файл кладётся в папку по uid — политика хранилища проверяет именно это,
 * поэтому чужую картинку подменить нельзя. Имя каждый раз новое: путь
 * попадает в кэш CDN, и перезапись под тем же именем оставляла бы
 * старое фото висеть ещё сутки.
 */
export async function uploadAvatar(uid, file) {
  if (!supabaseReady() || !uid || !file) return null;

  if (!AVATAR_MIME.includes(file.type)) {
    throw Object.assign(new Error('Нужен файл JPEG, PNG, WebP или GIF'), { code: 'avatar_type' });
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw Object.assign(new Error('Файл больше 2 МБ — выберите поменьше'), { code: 'avatar_size' });
  }

  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[file.type];
  const path = `${uid}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage.from('avatars').upload(path, file, {
    contentType: file.type,
    cacheControl: '31536000',
  });
  if (error) throw error;

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data?.publicUrl ?? null;
}

/** Ник по умолчанию из имени или почты: человеку не нужно придумывать с нуля. */
export function suggestUsername(source) {
  const base = String(source ?? '')
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._]/g, '')
    .slice(0, 20);
  if (base.length >= 3) return base;
  return `viewer${Math.floor(Math.random() * 9000 + 1000)}`;
}
