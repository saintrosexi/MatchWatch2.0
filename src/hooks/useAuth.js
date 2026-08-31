/**
 * Сессия пользователя.
 *
 * Два способа входа, один внутренний user_id:
 *   Telegram — initData уходит на сервер, там проверяется подпись HMAC,
 *              обратно приходит одноразовый token_hash, который клиент
 *              меняет на полноценную сессию;
 *   Email    — обычный вход Supabase Auth, затем сервер фиксирует
 *              идентичность, чтобы её потом можно было связать.
 *
 * Оба пути приводят к одному auth.users.id, а таблица identities
 * позволяет прицепить второй способ входа к тому же профилю.
 *
 * Запасной режим `password` включается, когда на сервере нет
 * SUPABASE_SERVICE_ROLE_KEY: там token_hash выписать некому, и клиент
 * входит выведенными из telegram_id учётными данными. Вход работает,
 * привязка к существующему аккаунту — нет.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, supabaseReady, supabaseInitError } from '../lib/supabase.js';
import { api, describeError, ApiClientError } from '../lib/api.js';
import { getInitData, getTelegramUser, isTelegram } from '../lib/telegram.js';
import { setTelemetryUser, trackError, trackMetric, breadcrumb } from '../lib/telemetry.js';
import { LEVEL, METRIC, MODULE } from '../../shared/telemetry/events.js';

const STATUS = Object.freeze({
  BOOTING: 'booting',
  ANONYMOUS: 'anonymous',
  SIGNING_IN: 'signing-in',
  READY: 'ready',
  DEGRADED: 'degraded',
});

/**
 * Сколько ждём восстановления сессии, прежде чем показать вход.
 *
 * Семь секунд — заметно дольше любого живого ответа и заметно короче
 * терпения человека, смотрящего на заставку. Ошибиться здесь в большую
 * сторону хуже: лишний невидимый вход стоит ничего, а зависший экран
 * стоит пользователя.
 */
const BOOT_TIMEOUT_MS = 7000;

const toSession = (user) => ({
  uid: user.id,
  displayName: user.user_metadata?.display_name
    ?? getTelegramUser()?.first_name
    ?? user.email?.split('@')[0]
    ?? 'Зритель',
  photoURL: user.user_metadata?.photo_url ?? getTelegramUser()?.photo_url ?? null,
  // Служебный адрес Telegram-аккаунта показывать пользователю незачем.
  email: user.email?.endsWith('.invalid') ? null : user.email ?? null,
  provider: user.user_metadata?.provider ?? user.app_metadata?.provider ?? 'email',
});

/** Access-token текущей сессии: им эндпоинты привязки доказывают, кто мы. */
async function accessToken() {
  if (!supabaseReady()) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Запасной вход без service_role: учётные данные выведены сервером из
 * telegram_id. Первый заход заводит аккаунт — подтверждать нечего,
 * адрес служебный и никуда не отправляется.
 */
async function signInWithDerivedCredentials(result) {
  let { error: signInError } = await supabase.auth.signInWithPassword({
    email: result.email,
    password: result.password,
  });
  if (!signInError) return;

  const { error: signUpError } = await supabase.auth.signUp({
    email: result.email,
    password: result.password,
    options: { data: result.metadata },
  });
  if (signUpError) throw signUpError;

  ({ error: signInError } = await supabase.auth.signInWithPassword({
    email: result.email,
    password: result.password,
  }));
  if (signInError) throw signInError;
}

export function useAuth() {
  const [status, setStatus] = useState(STATUS.BOOTING);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [startRoom, setStartRoom] = useState(null);
  const [justRegistered, setJustRegistered] = useState(false);
  const [links, setLinks] = useState(null);
  const autoAttempted = useRef(false);

  useEffect(() => {
    if (!supabaseReady()) {
      setStatus(STATUS.DEGRADED);
      setError({
        text: 'Supabase не настроен — комнаты и синхронизация недоступны. Личная лента работает локально.',
        retryable: false,
        detail: supabaseInitError()?.message,
      });
      return undefined;
    }

    /*
     * Старт обязан закончиться. Всегда.
     *
     * `getSession()` восстанавливает сохранённую сессию и, если срок
     * токена вышел, идёт его обновлять по сети. Тайм-аута у этого
     * запроса нет: в мобильном WebView он может висеть сколько угодно,
     * а вместе с ним висит и заставка «Открываем кинозал» — экран,
     * с которого нет ни одного выхода, даже кнопки.
     *
     * Поэтому ждём ограниченное время и при любом исходе — ответ,
     * ошибка, тишина — уходим на экран входа. Внутри Telegram он
     * тут же войдёт сам и человек не заметит подмены; в вебе увидит
     * форму, то есть хоть что-то, что можно нажать.
     */
    let settled = false;
    const finish = (fn) => { if (!settled) { settled = true; fn(); } };

    const fallback = setTimeout(() => {
      finish(() => {
        /*
         * Сохранённую сессию стираем: если она подвешивает старт, то
         * подвесит и следующий, и человек останется с намертво
         * заклинившим приложением. Один невидимый повторный вход
         * дешевле, чем кирпич.
         */
        try { window.localStorage?.removeItem('mw3.auth'); } catch { /* приватный режим */ }
        setStatus(STATUS.ANONYMOUS);
        trackError('Старт сессии не уложился в отведённое время', {
          module: MODULE.AUTH_SESSION, level: LEVEL.WARNING,
          error: new Error('getSession timeout'),
          context: { timeoutMs: BOOT_TIMEOUT_MS, telegram: isTelegram() },
        });
      });
    }, BOOT_TIMEOUT_MS);

    supabase.auth.getSession()
      .then(({ data }) => finish(() => {
        clearTimeout(fallback);
        if (data.session?.user) {
          const session = toSession(data.session.user);
          setUser(session);
          setTelemetryUser(session.uid, session);
          setStatus(STATUS.READY);
        } else {
          setStatus(STATUS.ANONYMOUS);
        }
      }))
      /* Отказ тоже завершает старт: без этого заставка вечная. */
      .catch((e) => finish(() => {
        clearTimeout(fallback);
        setStatus(STATUS.ANONYMOUS);
        trackError('Не удалось восстановить сессию', {
          module: MODULE.AUTH_SESSION, level: LEVEL.WARNING, error: e,
        });
      }));

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        const next = toSession(session.user);
        setUser(next);
        setTelemetryUser(next.uid, next);
        setStatus(STATUS.READY);
        setError(null);
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setTelemetryUser(null);
        setStatus(STATUS.ANONYMOUS);
      }
    });

    return () => {
      clearTimeout(fallback);
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signInWithTelegram = useCallback(async () => {
    setStatus(STATUS.SIGNING_IN);
    setError(null);
    breadcrumb('auth: telegram start');

    try {
      const initData = getInitData();
      if (!initData) {
        throw Object.assign(new Error('Telegram не передал initData'), { code: 'initdata_missing' });
      }

      // Сервер проверил подпись и решил, в какой аккаунт нас пускать:
      // в привязанный, если Telegram уже прицеплен к чужому email,
      // иначе в собственный телеграмный.
      const result = await api.authTelegram(initData);

      if (result.mode === 'otp') {
        const { error: otpError } = await supabase.auth.verifyOtp({
          token_hash: result.tokenHash,
          type: 'magiclink',
        });
        if (otpError) throw otpError;
      } else {
        await signInWithDerivedCredentials(result);
      }

      if (result.startRoom) setStartRoom(result.startRoom);
      // Свежесозданному телеграмному аккаунту стоит рассказать, что его
      // можно было привязать к уже существующему, — но ровно один раз.
      setJustRegistered(result.created === true && !result.linked);
      trackMetric(METRIC.SIGN_IN, { context: { provider: 'telegram', mode: result.mode } });
      return result;
    } catch (e) {
      const described = describeError(e);
      setError(described);
      setStatus(STATUS.ANONYMOUS);
      trackError('Вход через Telegram не удался', {
        module: MODULE.AUTH_TELEGRAM, level: LEVEL.ERROR, error: e, context: { code: e?.code },
      });
      throw e;
    }
  }, []);

  /* ── Привязка Telegram к уже существующему аккаунту ───────────── */

  const refreshLinks = useCallback(async () => {
    if (!supabaseReady()) return null;
    const token = await accessToken();
    if (!token) return null;
    try {
      const result = await api.identityStatus(token);
      setLinks(result);
      return result;
    } catch (e) {
      /*
       * Отсутствие service_role — не ошибка пользователя: вход работает,
       * просто привязка недоступна. Запоминаем это состояние, чтобы не
       * показывать кнопку, которая заведомо не сработает.
       */
      if (e?.code === 'linking_not_configured') {
        setLinks({ unavailable: true, reason: e.code, telegram: { linked: false } });
        return null;
      }
      trackError('Не удалось прочитать привязки аккаунта', {
        module: MODULE.AUTH_SESSION, level: LEVEL.WARNING, error: e,
      });
      return null;
    }
  }, []);

  const linkTelegram = useCallback(async () => {
    const initData = getInitData();
    if (!initData) {
      throw Object.assign(new Error('Telegram не передал initData'), { code: 'initdata_missing' });
    }
    const token = await accessToken();
    if (!token) throw Object.assign(new Error('Нет активной сессии'), { code: 'session_required' });

    const result = await api.linkTelegram(initData, token);
    setLinks(result);
    setJustRegistered(false);
    return result;
  }, []);

  const unlinkTelegram = useCallback(async () => {
    const token = await accessToken();
    if (!token) throw Object.assign(new Error('Нет активной сессии'), { code: 'session_required' });
    const result = await api.unlinkTelegram(token);
    setLinks(result);
    return result;
  }, []);

  const signInWithEmail = useCallback(async (email, password, { register = false, displayName } = {}) => {
    setStatus(STATUS.SIGNING_IN);
    setError(null);
    breadcrumb(`auth: email ${register ? 'register' : 'login'}`);

    try {
      /*
       * Регистрация не требует подтверждения почты: триггер
       * on_auth_user_autoconfirm помечает адрес подтверждённым в момент
       * создания, поэтому сессия выдаётся сразу и письма не уходят.
       * Email здесь — логин, а не канал верификации.
       */
      if (register) {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName ?? email.split('@')[0], provider: 'email' } },
        });
        if (signUpError) throw signUpError;
      }

      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;

      if (!data.session) {
        setStatus(STATUS.ANONYMOUS);
        setError({ text: 'Аккаунт создан, но сессия не выдана. Попробуйте войти ещё раз.', retryable: true });
        return false;
      }

      trackMetric(METRIC.SIGN_IN, { context: { provider: 'email', register } });
      return true;
    } catch (e) {
      // Ошибка нашего эндпоинта регистрации уже человекочитаема.
      const described = e instanceof ApiClientError ? describeError(e) : { text: emailErrorText(e), retryable: true };
      setError(described);
      setStatus(STATUS.ANONYMOUS);
      trackError('Вход по email не удался', {
        module: MODULE.AUTH_EMAIL, level: LEVEL.WARNING, error: e,
        context: { code: e?.code ?? e?.status, register },
      });
      throw e;
    }
  }, []);

  const resetPassword = useCallback(async (email) => {
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/`,
    });
    if (resetError) throw resetError;
  }, []);

  const logout = useCallback(async () => {
    if (supabaseReady()) await supabase.auth.signOut().catch(() => {});
    setUser(null);
    setLinks(null);
    setJustRegistered(false);
    setStatus(STATUS.ANONYMOUS);
  }, []);

  // Внутри Telegram вход происходит сам: заставлять пользователя нажимать
  // «Войти через Telegram», когда мы уже внутри Telegram, — лишний шаг.
  useEffect(() => {
    if (autoAttempted.current) return;
    if (status !== STATUS.ANONYMOUS || !isTelegram() || !supabaseReady()) return;
    autoAttempted.current = true;
    signInWithTelegram().catch(() => {});
  }, [status, signInWithTelegram]);

  // Список привязок нужен профилю; читаем один раз на сессию.
  useEffect(() => {
    if (status !== STATUS.READY || !user?.uid) return;
    refreshLinks();
  }, [status, user?.uid, refreshLinks]);

  return {
    status, user, error, startRoom, links, justRegistered,
    isReady: status === STATUS.READY,
    isDegraded: status === STATUS.DEGRADED,
    inTelegram: isTelegram(),
    signInWithTelegram, signInWithEmail, resetPassword, logout,
    refreshLinks, linkTelegram, unlinkTelegram,
    clearStartRoom: () => setStartRoom(null),
    dismissJustRegistered: () => setJustRegistered(false),
  };
}

export { STATUS as AUTH_STATUS };

/**
 * Текст ошибки должен называть настоящую причину.
 *
 * Отдельно разобран лимит писем: встроенный SMTP Supabase шлёт всего
 * пару писем в час, и упереться в него — не вина пользователя. Без явного
 * текста это выглядит как «приложение сломалось».
 */
function emailErrorText(error) {
  const code = String(error?.code ?? error?.error_code ?? '').toLowerCase();
  const message = String(error?.message ?? '').toLowerCase();
  const has = (...needles) => needles.some((n) => code.includes(n) || message.includes(n));

  if (has('over_email_send_rate_limit', 'email rate limit')) {
    return 'Supabase не отправляет письмо: исчерпан лимит встроенной почты '
      + '(пара писем в час). Отключите подтверждение email в настройках проекта '
      + 'или подключите свой SMTP.';
  }
  if (has('email_not_confirmed')) {
    return 'Аккаунт не подтверждён. Проверьте почту или отключите подтверждение '
      + 'email в настройках Supabase.';
  }
  if (has('email_address_invalid', 'unable to validate email')) {
    return 'Supabase считает этот адрес недействительным. Тестовые домены вроде '
      + 'example.com он отклоняет — возьмите настоящий.';
  }
  if (has('invalid_credentials', 'invalid login')) return 'Email или пароль не подходят.';
  if (has('user_already_exists', 'already registered')) return 'Этот email уже занят — попробуйте войти.';
  if (has('weak_password', 'password should be')) return 'Пароль слишком простой: минимум 6 символов.';
  if (has('over_request_rate_limit', 'too many')) return 'Слишком много попыток. Подождите минуту.';
  if (has('signup_disabled', 'signups not allowed')) return 'Регистрация отключена в настройках Supabase.';
  if (has('failed to fetch', 'network')) return 'Нет связи с сервером авторизации.';
  return error?.message ? `Не удалось войти: ${error.message}` : 'Не удалось войти. Попробуйте ещё раз.';
}
