import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { Bookmark, Dices, Flame, Library, SlidersHorizontal, UserRound, Users, IconContext, ICON, Star } from '../ui/icons.js';

import { useAuth } from '../hooks/useAuth.js';
import { usePlatform } from '../hooks/usePlatform.js';
import { useToasts } from '../hooks/useToasts.js';
import { useDeck, DECK_MODE } from '../hooks/useDeck.js';
import { useRoom } from '../hooks/useRoom.js';

import { MobileShell } from '../shells/mobile/MobileShell.jsx';
import { DesktopStudio } from '../shells/desktop/DesktopStudio.jsx';

import { SwipeDeck } from '../features/deck/SwipeDeck.jsx';
import { DetailsSheet } from '../features/deck/DetailsSheet.jsx';
import { FiltersSheet, DEFAULT_FILTERS } from '../features/deck/FiltersSheet.jsx';
import { RoomsView } from '../features/rooms/RoomsView.jsx';
import { CollectionView } from '../features/collection/CollectionView.jsx';
import { FeedModeSwitch } from '../features/deck/FeedModeSwitch.jsx';
import { DeckCoach, coachSeen } from '../features/deck/DeckCoach.jsx';
import { VaultView } from '../features/vault/VaultView.jsx';
import { loadFriends } from '../engine/social.js';
import { inviteFriendToRoom } from '../engine/rooms.js';
import { PremiumSheet } from '../features/premium/PremiumSheet.jsx';
import { FeedbackSheet } from '../features/profile/FeedbackSheet.jsx';
import { usePremium } from '../hooks/usePremium.js';
import { NewsScreen } from '../features/news/NewsScreen.jsx';
import { bannerNews } from '../../shared/config/news.js';
import { MeView } from '../features/profile/MeView.jsx';
import { AuthScreen } from '../features/auth/AuthScreen.jsx';

/*
 * Отложенные куски.
 *
 * Всё это открывается по случаю: празднование мэтча, рулетка, редактор
 * профиля, метрики, чужой профиль, обучение. Держать их в первом
 * загружаемом файле значит платить их весом на каждом холодном старте
 * ради экранов, до которых человек может не дойти вовсе. Празднование
 * вдобавок тянет за собой библиотеку конфетти.
 */
/*
 * Каждый ленивый экран обёрнут в `retryChunk`: после выкладки новой
 * версии имена файлов меняются, и страница, открытая со старой сборки,
 * идёт за файлом, которого больше нет. Празднование мэтча так и не
 * показалось никому — вместо него люди видели «Что-то сломалось».
 */
const MatchCelebration = lazy(retryChunk(() => import('../features/rooms/MatchCelebration.jsx')
  .then((m) => ({ default: m.MatchCelebration })), 'MatchCelebration'));
const ProfileEditor = lazy(retryChunk(() => import('../features/profile/ProfileEditor.jsx')
  .then((m) => ({ default: m.ProfileEditor })), 'ProfileEditor'));
const ShowcaseEditor = lazy(retryChunk(() => import('../features/profile/ShowcaseEditor.jsx')
  .then((m) => ({ default: m.ShowcaseEditor })), 'ShowcaseEditor'));
const WhatsNewView = lazy(retryChunk(() => import('../features/news/WhatsNewView.jsx')
  .then((m) => ({ default: m.WhatsNewView })), 'WhatsNewView'));
const SettingsView = lazy(retryChunk(() => import('../features/profile/SettingsView.jsx')
  .then((m) => ({ default: m.SettingsView })), 'SettingsView'));
const PublicProfileView = lazy(retryChunk(() => import('../features/profile/PublicProfileView.jsx')
  .then((m) => ({ default: m.PublicProfileView })), 'PublicProfileView'));
const DashboardView = lazy(retryChunk(() => import('../features/profile/DashboardView.jsx')
  .then((m) => ({ default: m.DashboardView })), 'DashboardView'));
const RouletteModal = lazy(retryChunk(() => import('../features/roulette/RouletteModal.jsx')
  .then((m) => ({ default: m.RouletteModal })), 'RouletteModal'));

import { retryChunk, clearChunkReload } from '../lib/lazyChunk.js';
import { Toasts } from '../ui/Toasts.jsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.jsx';
import { LoadingState, StatusStrip } from '../ui/States.jsx';
import { MoodBars } from '../ui/Radar.jsx';

import { ACTION, createEmptyProfile, hydrateProfile } from '../engine/tasteProfile.js';
import {
  loadUserState, subscribeUserState, recordReaction, toggleFavorite,
  undoDecision, markWatchedPersonal, rateTitle,
  applyLocalDecision, removeLocalDecision, mergeUserState,
  resolveAnchors,
} from '../engine/userData.js';
import { buildRoomDeck, roomHistory } from '../engine/roomDeck.js';
import { getConfig, initRemoteConfig } from '../engine/recommendationConfig.js';
import { REWATCH } from '../../shared/config/moodPresets.js';
import { mergeRequestFilters } from '../../shared/ai/interpretation.js';
import { JOIN_SOURCE, roomExcludedTitles } from '../engine/rooms.js';

import { loadLocal, saveLocal, STORAGE_KEYS } from '../lib/storage.js';
import { subscribeNetwork } from '../lib/network.js';
import { startOutbox, subscribeOutbox, flushOutbox } from '../lib/outbox.js';
import {
  setHapticsEnabled, getStartRoomCode, getStartDestination, getStartParamRaw,
  enableClosingConfirmation, haptic,
} from '../lib/telegram.js';
import { DESTINATION, parseStartParam } from '../../shared/model/startParam.js';
import { setSoundEnabled } from '../lib/sound.js';
import { trackError, trackMetric, breadcrumb } from '../lib/telemetry.js';
import { LEVEL, METRIC, MODULE } from '../../shared/telemetry/events.js';
import { normalizeRoomCode } from '../../shared/model/roomCode.js';

const VIEW = {
  DECK: 'deck',
  /** Каталог и звёзды — способы найти новое. */
  COLLECTION: 'collection',
  ROOMS: 'rooms',
  /** Всё, про что решение уже принято, — самостоятельный раздел. */
  MINE: 'mine',
  /** «Я» — профиль и друзья под одной вкладкой. */
  ME: 'me',
  /** Настройки профиля — всё служебное за одной дверью. */
  SETTINGS: 'settings',
  PUBLIC_PROFILE: 'public-profile',
  /** Что нового — история обновлений продукта. */
  NEWS: 'news',
  DASHBOARD: 'dashboard',
};

/**
 * `ratePrompt` — показывать ли в «Нравится» предложение оценить фильм.
 * Выключается кнопкой «Никогда не показывать» в самом предложении
 * и возвращается в настройках: раздражение проходит, а решение остаётся.
 */
const DEFAULT_PREFS = { sound: true, haptics: true, ratePrompt: true };

export default function App() {
  const platform = usePlatform();
  const auth = useAuth();
  const toasts = useToasts();

  const [view, setView] = useState(VIEW.DECK);
  const [online, setOnline] = useState(true);
  /** Сколько записей ждут отправки в базу. */
  const [pendingWrites, setPendingWrites] = useState(0);
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_PREFS, ...loadLocal(STORAGE_KEYS.PREFS, {}) }));
  const [filters, setFilters] = useState(() => loadLocal(STORAGE_KEYS.FILTERS, DEFAULT_FILTERS));

  const [userState, setUserState] = useState(null);
  const [showcaseOpen, setShowcaseOpen] = useState(false);
  const [premiumOpen, setPremiumOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /*
   * Кто уже в друзьях — множество идентификаторов.
   *
   * Живёт в приложении, а не в каждом экране: кнопку «добавить в друзья»
   * предлагают комната, празднование мэтча и профиль, и без общего знания
   * каждая из них врала независимо от остальных. Дозагрузка одна на вход.
   */
  const [friendIds, setFriendIds] = useState(() => new Set());
  /**
   * Объявление, которое человек ещё не видел.
   *
   * Одно на обновление и только помеченное `banner: true` в конфиге
   * новостей. Всё остальное живёт в «Что нового» и никого не перебивает.
   */
  const [announced, setAnnounced] = useState(null);

  /*
   * Куда возвращает «назад» из дневника.
   *
   * В дневник приходят с двух сторон: из настроек и из разового
   * объявления. Одна и та же кнопка «назад» не может быть права
   * в обоих случаях — она либо теряет место человека в настройках,
   * либо уводит его в экран, который он не открывал.
   */
  const [newsFrom, setNewsFrom] = useState(VIEW.ME);

  const openNews = useCallback((from) => {
    setNewsFrom(from);
    setView(VIEW.NEWS);
  }, []);

  /*
   * Прочитанное гасится, но остаётся на месте.
   *
   * Блок «что нового» постоянный, как в банковских приложениях: разовое
   * уведомление живёт до первого касания, и закрывший его не глядя
   * больше никогда не узнает, что там было.
   */
  /*
   * Показ решается один раз, при первом рендере после входа.
   *
   * Не в `useMemo` от `seenNews`: иначе объявление исчезло бы в тот же
   * миг, когда мы пометили его прочитанным, — вместе с открытой поверх
   * него витриной. Решение принимается один раз и живёт до закрытия.
   */
  useEffect(() => {
    const item = bannerNews();
    if (item && !loadLocal(STORAGE_KEYS.NEWS_SEEN, []).includes(item.id)) {
      setAnnounced(item);
    }
  }, []);

  /*
   * Прочитанное пишем прямо в хранилище, без состояния в React.
   *
   * Состояние здесь ничего не рисует: объявление одно, решение о показе
   * принято при входе, а список прочитанного нужен только следующему
   * запуску. Лишний `useState` заставлял бы перерисовывать всё
   * приложение ради значения, которого никто не читает.
   */
  const markNewsSeen = useCallback((item) => {
    if (!item) return;
    const seen = loadLocal(STORAGE_KEYS.NEWS_SEEN, []);
    if (seen.includes(item.id)) return;
    saveLocal(STORAGE_KEYS.NEWS_SEEN, [...seen, item.id]);
  }, []);
  /*
   * Режим подачи ленты. Живёт в памяти сессии и никуда не сохраняется:
   * это выбор настроения на вечер, а не свойство человека. Перезашёл —
   * снова спокойный, как и было задумано.
   */
  const [feedMode, setFeedMode] = useState('calm');
  /*
   * Подсказки по ленте. Показываются один раз и только когда карточка
   * уже на экране: объяснять жест, указывая на спиннер, бессмысленно.
   */
  const [coachOpen, setCoachOpen] = useState(false);
  const [taste, setTaste] = useState(createEmptyProfile);

  const [detailsEntry, setDetailsEntry] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [rouletteOpen, setRouletteOpen] = useState(false);
  const [actorDeck, setActorDeck] = useState(null);
  const [lastDecision, setLastDecision] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [publicProfile, setPublicProfile] = useState(null);
  /** Какую половину раздела «Я» открыть — задаётся меню на большом экране. */
  const [meTab, setMeTab] = useState('profile');
  /** Каталог или актёры — на большом экране это два пункта меню. */
  const [collectionSection, setCollectionSection] = useState('catalog');
  const [focusPerson, setFocusPerson] = useState(null);
  const [roomSession, setRoomSession] = useState(false);

  const user = auth.user;
  /*
   * Премиум читается с сервера и живёт рядом с остальным состоянием
   * аккаунта. На клиенте он НЕ вычисляется: часы на устройстве
   * переводятся в два касания.
   */
  const premium = usePremium({ uid: user?.uid, enabled: Boolean(user?.uid) });

  useEffect(() => {
    if (!user?.uid) { setFriendIds(new Set()); return; }
    let alive = true;
    loadFriends()
      .then((list) => {
        if (!alive) return;
        setFriendIds(new Set(list
          .filter((f) => f.status === 'accepted')
          .map((f) => f.id)));
      })
      .catch(() => { /* список друзей — украшение кнопки, не условие работы */ });
    return () => { alive = false; };
  }, [user?.uid]);
  // Стабильная ссылка: иначе колбэки комнаты пересоздаются на каждый рендер.
  const roomUser = useMemo(
    () => user ?? { uid: 'anonymous', displayName: 'Гость', photoURL: null },
    [user],
  );
  /*
   * Полные карточки опор. Историю решений мы получаем сразу, но теги
   * в ней не лежат — снимок карточки компактный, и первая версия
   * молча оставалась без опор у всех до единого. Догружаем из каталога
   * отдельно, не задерживая первый экран: без опор подборка работает
   * по накопленному вектору, просто хуже.
   */
  const [anchors, setAnchors] = useState(null);

  useEffect(() => {
    const raw = userState?.anchors;
    if (!raw?.loved?.length && !raw?.refused?.length) { setAnchors(null); return undefined; }

    let cancelled = false;
    resolveAnchors(raw)
      .then((resolved) => { if (!cancelled) setAnchors(resolved); })
      .catch(() => { if (!cancelled) setAnchors(null); });

    return () => { cancelled = true; };
  }, [userState?.anchors]);

  const room = useRoom({ user: roomUser, taste, anchors });

  /*
   * Любимые фильмы остальных участников — для подписи под карточкой.
   *
   * Порядок колоды и так считается по опорам каждого, но человеку
   * этого не видно, а решает он именно вопрос «а ей зайдёт?».
   * Поэтому рядом со своей опорой называется опора партнёра — с именем,
   * потому что в комнате сидят знакомые люди.
   *
   * Свои сюда не попадают: про них говорит первая строка.
   */
  const [roomPartners, setRoomPartners] = useState([]);
  const partnersKey = (room.members ?? [])
    .filter((m) => m.uid !== roomUser?.uid)
    .map((m) => `${m.uid}:${(m.lovedIds ?? []).join(',')}`)
    .join('|');

  useEffect(() => {
    const others = (room.members ?? [])
      .filter((m) => m.uid !== roomUser?.uid && (m.lovedIds ?? []).length);

    if (!others.length) { setRoomPartners([]); return undefined; }

    let cancelled = false;
    Promise.all(others.map((m) =>
      resolveAnchors({ loved: m.lovedIds.map((id) => ({ id })), refused: [] })
        .then((r) => ({ name: m.name, loved: r.loved }))
        .catch(() => null)))
      .then((list) => {
        if (!cancelled) setRoomPartners(list.filter((p) => p?.loved?.length));
      });

    return () => { cancelled = true; };
    // Ключ вместо самого массива: `members` пересоздаётся на каждом
    // обновлении присутствия, и по нему эффект крутился бы вхолостую.
  }, [partnersKey, roomUser?.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const deckPoolRef = useRef([]);
  const deckRef = useRef(null);
  const publishedFor = useRef(null);

  /* ── Сеть ────────────────────────────────────────────────────── */
  useEffect(() => subscribeNetwork((state) => setOnline(state.online)), []);

  /*
   * Очередь отложенной записи: гарантирует, что отметки доедут до базы
   * даже если сеть пропала в момент действия. Без неё они оставались бы
   * только на экране и исчезали после перезагрузки.
   */
  useEffect(() => {
    /*
     * Приложение поднялось — значит перезагрузка после отвалившегося
     * чанка сработала. Снимаем отметку, иначе одна давняя неудача
     * навсегда запретила бы перезагрузку в этой вкладке.
     */
    clearChunkReload();

    const stop = startOutbox();
    const unsubscribe = subscribeOutbox(setPendingWrites);
    return () => { stop(); unsubscribe(); };
  }, []);

  /* ── Предпочтения ────────────────────────────────────────────── */
  useEffect(() => {
    setSoundEnabled(prefs.sound);
    setHapticsEnabled(prefs.haptics);
    saveLocal(STORAGE_KEYS.PREFS, prefs);
  }, [prefs]);

  useEffect(() => { saveLocal(STORAGE_KEYS.FILTERS, filters); }, [filters]);

  /* ── Данные пользователя ─────────────────────────────────────── */
  useEffect(() => {
    if (!user?.uid) return undefined;
    let alive = true;

    loadUserState(user.uid)
      .then((state) => {
        if (!alive) return;
        setUserState((prev) => mergeUserState(prev, state));
        setTaste(hydrateProfile(state.taste));
      })
      .catch((error) => {
        // Колода ждёт загруженного состояния, поэтому пустой отказ здесь
        // означал бы вечный спиннер. Разворачиваемся в пустой профиль:
        // лента заработает, а история подтянется при следующей попытке.
        if (!alive) return;
        trackError('Не удалось загрузить состояние пользователя', {
          module: MODULE.TASTE, level: LEVEL.ERROR, error,
        });
        /*
         * Пустое состояние ставим только с нуля. Если что-то уже было
         * показано, оно и остаётся: перезатирать его пустотой из-за
         * одной неудачной попытки — ровно то, что человек читает как
         * «у меня пропали все списки».
         */
        setUserState((prev) => prev ?? {
          profile: {}, access: { tier: 'free', stars: 0 },
          history: {}, wishlist: {}, watched: {}, favorites: {}, ratings: {}, matches: {},
        });
        toasts.error('История решений не загрузилась — лента может показать уже просмотренное.');
      });

    // Подписка сообщает лишь факт изменения: состояние перечитываем целиком,
    // иначе пять таблиц пришлось бы сливать вручную и расхождения неизбежны.
    const unsubscribe = subscribeUserState(user.uid, () => {
      if (!alive) return;
      loadUserState(user.uid).then((state) => {
        // Сбойный разрез не должен стирать то, что уже показано:
        // «список не приехал» и «список пуст» выглядят одинаково.
        if (alive) setUserState((prev) => mergeUserState(prev, state));
      });
    });

    const stopConfig = initRemoteConfig({ uid: user.uid });
    trackMetric(METRIC.APP_OPEN, { context: { shell: platform.shell, telegram: platform.telegram } });

    return () => { alive = false; unsubscribe?.(); stopConfig?.(); };
  }, [user?.uid, platform.shell, platform.telegram]);

  /*
   * ── Кнопки бота-навигатора: открыться сразу на нужном экране ──
   *
   * Отдельно от deep-link в комнату: там нужно ВОЙТИ в комнату, здесь —
   * только показать раздел. Смешивать нельзя, иначе «покажи ленту»
   * пыталось бы куда-то вступить.
   *
   * Премиум — не экран, а витрина поверх ленты: бот обещает показать
   * подписку, и человек должен увидеть именно её, а не вкладку профиля,
   * где она где-то есть.
   */
  const destinationHandled = useRef(false);
  useEffect(() => {
    if (destinationHandled.current || !auth.isReady || !user?.uid) return;
    const to = getStartDestination();
    if (!to) return;

    destinationHandled.current = true;
    breadcrumb(`бот: открыть раздел ${to}`);

    if (to === DESTINATION.PREMIUM) setPremiumOpen(true);
    else setView(to);
  }, [auth.isReady, user?.uid]);

  /*
   * ── Ссылка на чужой профиль из чата ──
   *
   * Отдельно от разделов: здесь нужно ещё и подставить, ЧЕЙ профиль,
   * а не просто открыть экран. Разбор общий с ботом, поэтому ник,
   * который бот положил в карточку, доезжает сюда без потерь.
   */
  const profileLinkHandled = useRef(false);
  useEffect(() => {
    if (profileLinkHandled.current || !auth.isReady || !user?.uid) return;
    const parsed = parseStartParam(getStartParamRaw());
    if (parsed?.kind !== 'profile') return;

    profileLinkHandled.current = true;
    breadcrumb(`ссылка на профиль @${parsed.username}`);
    setPublicProfile(parsed.username);
    setView(VIEW.PUBLIC_PROFILE);
  }, [auth.isReady, user?.uid]);

  /* ── Deep-link в комнату: ?room=CODE или Telegram start_param ── */
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || !auth.isReady || !user?.uid) return;

    const fromTelegram = getStartRoomCode();
    const fromQuery = normalizeRoomCode(new URLSearchParams(window.location.search).get('room'));
    const code = auth.startRoom ?? fromTelegram ?? fromQuery;
    if (!code) return;

    deepLinkHandled.current = true;
    const source = auth.startRoom || fromTelegram ? JOIN_SOURCE.DEEP_LINK : JOIN_SOURCE.LINK;
    breadcrumb(`deep-link: комната ${code} (${source})`);

    room.join(code, source)
      .then(() => {
        setView(VIEW.ROOMS);
        auth.clearStartRoom();
        toasts.success(`Вы в комнате ${code}`);
      })
      .catch((error) => toasts.error(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isReady, auth.startRoom, user?.uid]);

  /* ── Хост публикует общую колоду, когда состав комнаты меняется ── */
  useEffect(() => {
    if (!room.code || !room.isHost || !room.consensus) return;
    const memberCount = room.members.length;
    /*
     * Колода больше не пересобирается сама при каждом входе участника:
     * пересборка стирала прогресс тех, кто уже свайпал. Её строят один
     * раз кнопкой в лобби, а дальше она только дописывается.
     */
    const key = `${room.code}:${memberCount}`;
    if (publishedFor.current === key) return;
    publishedFor.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.code, room.isHost, room.members.length, room.consensus]);


  /* ── Подтверждение выхода, пока идёт сессия в комнате ─────────── */
  useEffect(() => {
    enableClosingConfirmation(Boolean(room.code && roomSession));
    return () => enableClosingConfirmation(false);
  }, [room.code, roomSession]);

  /* ── Колода ──────────────────────────────────────────────────── */
  const deckMode = actorDeck
    ? DECK_MODE.ACTOR
    : room.code && roomSession ? DECK_MODE.ROOM : DECK_MODE.SOLO;

  const history = useMemo(() => {
    const base = { ...(userState?.history ?? {}) };
    if (deckMode === DECK_MODE.ROOM && room.state) {
      Object.assign(base, roomHistory(room.state, user?.uid));
    }
    return base;
  }, [userState?.history, deckMode, room.state, user?.uid]);




  /*
   * Опоры всей комнаты: свои плюс любимые остальных участников.
   *
   * Раньше сюда уходили опоры только того, кто нажал «собрать колоду».
   * Собрал он — вечер по его вкусу, собрала она — по её, и никогда
   * по обоим: половине комнаты подборка была чужой.
   */
  const roomAnchors = useCallback(async () => {
    /*
     * Опоры разложены ПО УЧАСТНИКАМ, а не свалены в один список.
     *
     * Мэтч — это согласие обоих, и оценка считается как вероятность
     * двойного «да». Одним списком фильм, идеальный ему и никакой ей,
     * выходил бы наверх — хотя мэтчем он не станет никогда.
     */
    const byMember = room.members
      .map((m) => (m.lovedIds ?? []))
      .filter((ids) => ids.length);

    if (!byMember.length) return { anchors, groups: null };

    const resolved = await Promise.all(byMember.map((ids) =>
      resolveAnchors({ loved: ids.map((id) => ({ id })), refused: [] })
        .then((r) => r.loved)
        .catch(() => [])));

    const groups = resolved.filter((g) => g.length);
    if (!groups.length) return { anchors, groups: null };

    // Общий список тоже нужен: по нему считается близость, когда групп
    // меньше двух, и из него берётся объяснение под карточкой.
    const seen = new Set();
    const loved = groups.flat().filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));

    // Отвергнутое остаётся своим: чужие отказы уже учтены исключениями.
    return { anchors: { loved, refused: anchors?.refused ?? [] }, groups };
  }, [room.members, anchors]);

  const deck = useDeck({
    mode: deckMode,
    filters,
    taste,
    history,
    /** Опоры вкуса: конкретные любимые фильмы вместо усреднённой точки. */
    anchors,
    // В комнате и в колоде актёра режим не участвует: там свой порядок.
    feedMode: deckMode === DECK_MODE.SOLO ? feedMode : 'calm',
    actorId: actorDeck?.id ?? null,
    roomDeck: deckMode === DECK_MODE.ROOM ? room.state?.deck : null,
    roomSwiped: deckMode === DECK_MODE.ROOM ? room.swipedTitleIds : null,
    /** Любимые остальных участников — из них берётся вторая строка подписи. */
    roomPartners: deckMode === DECK_MODE.ROOM ? roomPartners : null,
    /*
     * Колода не собирается, пока не приехала история решений: иначе
     * исключать нечего и всё отклонённое возвращается в ленту.
     */
    enabled: Boolean(userState) && (Boolean(user?.uid) || auth.isDegraded),
  });

  /*
   * Колода дописывается, пока в ней есть что смотреть.
   *
   * Публиковалась она один раз, и вдвоём её проходили за десяток свайпов —
   * «колода закончилась» приходило там, где раньше листали сотнями.
   * Заказ уходит заранее, за несколько карточек до конца, чтобы пауза
   * пришлась на чужой ход, а не на пустой экран.
   */
  const growingRef = useRef(false);
  /*
   * Пул каталога живёт между догрузками.
   *
   * Дорогой была не частота попыток, а то, что каждая начиналась с нуля:
   * новый пул, три сотни карточек, два десятка обогащений — и так на
   * каждые двадцать пять фильмов. Сохранённый пул листается дальше
   * с той страницы, где остановился, и очередная порция стоит один-два
   * запроса. Ограничивать число попыток поэтому не нужно: колода растёт,
   * пока в каталоге есть что показать, а каталог у TMDB — тысячи фильмов.
   */
  const growthPoolRef = useRef(null);

  // Своя комната и свои фильтры — свой пул: чужой отдал бы не те фильмы.
  useEffect(() => { growthPoolRef.current = null; }, [room.code, filters]);

  useEffect(() => {
    if (deckMode !== DECK_MODE.ROOM || !room.code || !room.state) return;
    if (growingRef.current) return;

    /*
     * Колода растёт, только когда порцию прошли ВСЕ.
     *
     * Упреждающая догрузка «за восемь карточек до конца» здесь не годится:
     * быстрый участник уехал бы вперёд на новую порцию, пока медленный
     * ещё в старой, и общая колода перестала бы быть общей. Тот, кто
     * закончил раньше, видит экран ожидания — это честная пауза, а не
     * пустой экран.
     */
    const { size, slowest } = room.progress;
    if (!size || slowest < size) return;

    growingRef.current = true;
    const published = (room.state.deck ?? []).map((t) => t.id ?? t.titleId).filter(Boolean);

    roomExcludedTitles(room.code)
      .catch(() => [])
      .then(async (excluded) => {
        const { anchors: roomLoved, groups } = await roomAnchors();
        return buildRoomDeck({
          consensus: room.consensus ?? taste,
          anchors: roomLoved,
          anchorGroups: groups,
          filters,
          history: roomHistory(room.state, user?.uid),
          excludeIds: [...published, ...excluded],
          pool: growthPoolRef.current,
          moodRequests: room.moodRequests,
        });
      })
      .then(({ deck: next, pool }) => {
        growthPoolRef.current = pool;
        // Длина, которую видели мы: если она изменилась, порцию уже дописал другой.
        return next.length ? room.growDeck(next, published.length) : null;
      })
      .catch(() => { /* следующая карточка попробует снова */ })
      .finally(() => { growingRef.current = false; });
    /*
     * `progress.slowest` в зависимостях обязателен.
     *
     * Раньше эффект ждал только изменения длины очереди — и этого хватало
     * ровно до первого случая, когда человек заканчивал пачку раньше
     * остальных. Очередь у него становилась нулевой, эффект срабатывал,
     * видел, что медленный ещё не дошёл, и выходил. Когда медленный
     * доходил, длина очереди уже была нулевой и НЕ МЕНЯЛАСЬ — эффект
     * не запускался больше никогда, и колода не росла. Со стороны это
     * выглядело как вечная загрузка.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckMode, room.code, deck.queue.length, room.progress.slowest, room.progress.size]);

  /*
   * Снимок колоды для тех мест, куда её не передать пропсом.
   *
   * Разнесено на два эффекта не для красоты: `deck` — новый объект
   * на каждый рендер, и в общем эффекте перебор всей очереди по шесть
   * десятков карточек шёл на любую перерисовку экрана, включая тост
   * и тик прогресса комнаты. Перебор нужен, только когда очередь
   * действительно поменялась.
   */
  useEffect(() => {
    if (deck.queue.length) deckPoolRef.current = deck.queue.map((e) => e.title);
  }, [deck.queue]);

  useEffect(() => { deckRef.current = deck; });

  // Смена колоды обнуляет историю отмены: возвращать нечего.
  useEffect(() => { setLastDecision(null); }, [deckMode, actorDeck]);

  /*
   * Подсказки поднимаются, когда на экране действительно есть карточка:
   * объяснять жест, указывая на спиннер, бессмысленно.
   */
  useEffect(() => {
    if (coachSeen() || coachOpen) return;
    if (view !== VIEW.DECK || deckMode !== DECK_MODE.SOLO || !deck.current) return;
    setCoachOpen(true);
  }, [view, deckMode, deck.current, coachOpen]);

  /* ── Реакция на карточку ─────────────────────────────────────── */
  const handleDecision = useCallback(async (entry, action) => {
    const title = entry.title;

    /*
     * Свайп в комнате остаётся в комнате.
     *
     * Здесь решается не «люблю ли я этот фильм», а «будем ли мы смотреть
     * его сегодня вместе». Это разные вопросы, и путать их нельзя.
     * «Мимо» в комнате часто значит «не под настроение вечера» или
     * «не с ней»; записывать это как личный отказ — значит выкинуть
     * фильм из своей ленты навсегда за то, чего человек не говорил.
     * Обратное так же неверно: «да» на фильм, который мы обсуждаем
     * посмотреть вдвоём, не делает его любимым и не место ему
     * в избранном.
     *
     * Влияние остаётся односторонним, и так и задумано: личные решения
     * по-прежнему убирают фильмы из общей колоды — то, что человек уже
     * отверг сам, предлагать ему вдвоём незачем.
     *
     * Профиль вкуса здесь тоже не трогается. Иначе вечер вдвоём тихо
     * переписывал бы личные рекомендации решениями, принятыми не про
     * себя. Настроение самой сессии лента всё равно слышит — оно живёт
     * в памяти и завтра исчезает само.
     */
    if (deckMode === DECK_MODE.ROOM) {
      // Отменять нечего в профиле — только вернуть карточку в ленту.
      setLastDecision({ entry, action, previousTaste: null, roomOnly: true });
      await room.swipe(title, action === ACTION.DISLIKE ? 'pass' : 'like');
      /*
       * Мэтч записывает сама функция комнаты — и сразу всем участникам,
       * включая личное «буду смотреть». Это не свайп, а согласованное
       * решение смотреть, и ему в личном списке место.
       */
      return;
    }

    // Снимок профиля до действия: отменить решение иначе нельзя —
    // applySignal необратим из-за старения и массы настроения.
    setLastDecision({ entry, action, previousTaste: taste });

    // Списки и профиль обновляем в том же кадре: ждать ответа базы,
    // чтобы отметка появилась на экране, — значит выглядеть сломанным.
    setUserState((prev) => applyLocalDecision(prev, title, action));

    const nextTaste = await recordReaction({
      uid: user?.uid, title, action, taste,
      surface: deckMode,
      // Что движок обещал по этой карточке — чтобы потом сверить с исходом.
      prediction: {
        confidence: entry.confidence ?? null,
        slot: entry.slot ?? null,
        becauseOf: entry.becauseOf ?? null,
        score: entry.score ?? null,
      },
    });
    setTaste(nextTaste);
  }, [user?.uid, taste, deckMode, room]);

  /**
   * Отметка прямо из карточки фильма.
   *
   * В отличие от свайпа, это решение не идёт в комнату: карточку
   * открывают из каталога и от актёра, где никакого общего выбора нет.
   * Повторное нажатие снимает отметку — иначе поставленное по ошибке
   * сердце убрать неоткуда.
   */
  const handleToggleDecision = useCallback(async (title, action) => {
    const already = history[title.id] === action;
    if (already) {
      setUserState((prev) => removeLocalDecision(prev, title.id));
      const restored = await undoDecision({ uid: user?.uid, titleId: title.id, previousTaste: taste });
      setTaste(restored ?? taste);
      return;
    }

    setUserState((prev) => applyLocalDecision(prev, title, action));
    const nextTaste = await recordReaction({ uid: user?.uid, title, action, taste, surface: 'details' });
    setTaste(nextTaste);
  }, [history, user?.uid, taste]);

  const handleToggleWatched = useCallback(async (title) => {
    const watched = history[title.id] === 'watched';

    /*
     * Списки обновляем здесь же, а не ждём события из базы.
     *
     * Соседние обработчики так и делают, а этот единственный полагался
     * на живую подписку — и отметка не появлялась в «Просмотрено» до
     * перезагрузки всякий раз, когда канал обрывался. В Telegram он
     * обрывается регулярно.
     */
    setUserState((prev) => (watched
      ? removeLocalDecision(prev, title.id)
      : applyLocalDecision(prev, title, ACTION.WATCHED)));

    const nextTaste = await markWatchedPersonal({ uid: user?.uid, title, taste, watched: !watched });
    setTaste(nextTaste);
    if (room.code) await room.markWatched(title.id, !watched);
    toasts.success(watched ? 'Вернули в ленту' : 'Отметили как просмотренное');
  }, [history, user?.uid, taste, room, toasts]);

  /**
   * Отмена решения. Возвращает карточку в колоду и откатывает профиль
   * вкуса к снимку, снятому перед действием.
   */
  const handleUndo = useCallback(async () => {
    if (!lastDecision) return;
    const { entry, previousTaste, roomOnly } = lastDecision;
    setLastDecision(null);
    deckRef.current?.restore(entry);

    /*
     * Отмена в комнате возвращает карточку — и только. Отменять в личном
     * нечего: свайп туда и не записывался, а вызов `undoDecision` стёр бы
     * настоящее личное решение по этому фильму, принятое когда-то раньше.
     */
    if (roomOnly) {
      haptic('light');
      toasts.push(`Вернули «${entry.title.title}»`);
      return;
    }

    setUserState((prev) => removeLocalDecision(prev, entry.title.id));
    const restored = await undoDecision({
      uid: user?.uid, titleId: entry.title.id, previousTaste,
    });
    setTaste(restored ?? previousTaste);
    haptic('light');
    toasts.push(`Вернули «${entry.title.title}»`);
  }, [lastDecision, user?.uid, toasts]);

  /** То же самое из списков «Моё»: убрать решение и вернуть фильм в выбор. */
  const handleUndoFromList = useCallback(async (stub) => {
    const titleId = stub.id ?? stub.titleId;
    setUserState((prev) => removeLocalDecision(prev, titleId));
    await undoDecision({ uid: user?.uid, titleId, previousTaste: taste });
    toasts.push(`«${stub.title}» снова в выборе`);
  }, [user?.uid, taste, toasts]);

  /**
   * Оценка фильма. Заодно помечает его просмотренным: оценить можно
   * только то, что видел, и оставлять такое кино в ленте бессмысленно.
   */
  const handleRate = useCallback(async (title, value) => {
    if (!value) return;

    /*
     * Оценка не сбрасывает «нравится» и не отменяет мэтч.
     *
     * Решение по тайтлу одно, и оценка по умолчанию ставит «просмотрено»:
     * оценить можно только то, что видел. Но для любимого это означало
     * бы, что девятка выкидывает фильм из «Нравится», — а мы сами просим
     * оценить накопленное любимое, то есть предлагали бы человеку
     * опустошить собственный список. Эти два решения не спорят: одно
     * про «мой фильм», другое про «насколько хорош».
     */
    const previous = userState?.history?.[title.id];
    const action = previous === ACTION.FAVORITE || previous === ACTION.MATCH
      ? previous
      : ACTION.WATCHED;

    setUserState((prev) => applyLocalDecision(prev, title, action, { rating: value }));
    const nextTaste = await rateTitle({ uid: user?.uid, title, rating: value, taste, action });
    setTaste(nextTaste);
    haptic('success');
    toasts.success(`Оценка ${value} — учтём в рекомендациях`);
  }, [user?.uid, taste, toasts, userState?.history]);

  const handleRemoveFavorite = useCallback(async (stub) => {
    const titleId = stub.id ?? stub.titleId;
    setUserState((prev) => removeLocalDecision(prev, titleId));
    const nextTaste = await toggleFavorite({
      uid: user?.uid, title: { ...stub, id: titleId }, isFavorite: true, taste,
    });
    setTaste(nextTaste);
    await undoDecision({ uid: user?.uid, titleId, previousTaste: taste });
    toasts.push(`«${stub.title}» убран из понравившихся`);
  }, [user?.uid, taste, toasts]);

  const startActorDeck = useCallback((person) => {
    setActorDeck(person);
    setView(VIEW.DECK);
    haptic('medium');
    toasts.success(`Колода: ${person.name}`);
  }, [toasts]);

  /*
   * Комната создаётся пустой.
   *
   * Раньше колода собиралась в момент создания — по вкусу одного хоста,
   * ещё до того, как кто-то зашёл. Общей она при этом не была: второй
   * участник получал чужую подборку. Теперь сначала все собираются,
   * и только потом колода строится по компромиссу всех, кто внутри.
   */
  const createRoom = useCallback(async () => {
    try {
      return await room.create({ deck: [], filters });
    } catch (error) {
      /*
       * Упёрлись в границу тарифа — открываем витрину прямо здесь.
       *
       * Показать сообщение и оставить человека наедине с ним значило бы
       * сообщить об отказе и не дать способа его снять. Витрина в этот
       * момент не реклама, а продолжение действия, которое он начал.
       */
      if (error?.code === 'limit_reached') setPremiumOpen(true);
      throw error;
    }
  }, [filters, room]);

  const [deckBuilding, setDeckBuilding] = useState(false);

  /**
   * Позвать друга смотреть — с его страницы или из комнаты.
   *
   * Комнату заводим на месте, если её ещё нет: человек нажал «позвать
   * смотреть», и отправлять его сначала создавать комнату значит
   * прервать ровно то действие, которое он начал.
   */
  const inviteFriendToWatch = useCallback(async (person) => {
    try {
      const code = room.code ?? await createRoom();
      if (!code) return;
      await inviteFriendToRoom(code, person.id);
      toasts.success(`Позвали ${person.displayName} в комнату ${code}`);
      setRoomSession(true);
      setView(VIEW.ROOMS);
    } catch (error) {
      toasts.error(error?.message ?? 'Не получилось позвать');
    }
  }, [room.code, createRoom, toasts]);

  /** Собрать общую колоду по вкусам всех, кто сейчас в комнате. */
  const buildSharedDeck = useCallback(async () => {
    if (!room.code || deckBuilding) return;
    /*
     * Собирает только хост. Колода публикуется на всю комнату, и если
     * её пересоберёт второй участник, у первого прогресс обнулится
     * посреди сессии.
     */
    if (!room.isHost) return;

    setDeckBuilding(true);
    try {
      /*
       * Просмотренное и любимое всех участников выкидывается один раз,
       * здесь: показывать паре то, что кто-то из них уже видел, незачем,
       * а личная фильтрация при показе разъезжала общий порядок.
       */
      const rewatch = (room.moodRequests ?? []).some((r) => (r?.keys ?? r ?? []).includes(REWATCH));
      const excluded = await roomExcludedTitles(room.code, { keepFavorites: rewatch });

      /*
       * Жёсткие условия, названные словами, доезжают до каталога:
       * «не длиннее двух часов» — это запрос к выборке, а не оттенок
       * настроения, и решать его подкруткой весов было бы враньём.
       * Фильтры комнаты при этом главнее: их выставили осознанно
       * и заранее.
       */
      const asked = mergeRequestFilters(room.moodRequests ?? []);
      // Один вызов на сборку: внутри сетевые запросы за карточками опор.
      const { anchors: roomLoved, groups } = await roomAnchors();

      const { deck } = await buildRoomDeck({
        consensus: room.consensus ?? taste,
        anchors: roomLoved,
        anchorGroups: groups,
        filters: { ...asked, ...filters },
        history: roomHistory(room.state, user?.uid),
        excludeIds: excluded,
        moodRequests: room.moodRequests,
      });
      if (!deck.length) {
        toasts.error('Под эти фильтры ничего не нашлось. Ослабьте их и попробуйте снова.');
        return;
      }
      await room.setDeck(deck);
      toasts.success(`Колода готова: ${deck.length} фильмов`);
    } catch {
      toasts.error('Не удалось собрать общую колоду. Попробуйте ещё раз.');
    } finally {
      setDeckBuilding(false);
    }
  }, [room, deckBuilding, taste, filters, user?.uid, toasts]);

  /*
   * Первый вход через Telegram завёл новый аккаунт. Если у человека уже был
   * профиль по email, он об этом сейчас не догадывается — история окажется
   * пустой, и виноватым будет выглядеть приложение.
   */
  useEffect(() => {
    if (!auth.justRegistered) return;
    toasts.push('Аккаунт создан через Telegram. Был профиль по email? Профиль → «Вход через Telegram».', { ttl: 8000 });
    auth.dismissJustRegistered();
  }, [auth.justRegistered]);

  /* ── Гейты рендера ───────────────────────────────────────────── */
  if (auth.status === 'booting') {
    return <div className="app-root"><LoadingState text="Открываем кинозал…" /></div>;
  }

  /*
   * Слайдов перед лентой больше нет.
   *
   * Обучение целиком живёт в подсказках поверх колоды (`DeckCoach`):
   * они объясняют то же самое, но по месту и тогда, когда на экране
   * есть настоящая карточка. Семь слайдов до продукта стоили нам
   * ровно того человека, который пришёл посмотреть, что это такое.
   */
  if (!user && !auth.isDegraded) {
    return <div className="app-root"><AuthScreen auth={auth} /></div>;
  }

  const sessionUser = user ?? roomUser;

  const pendingInRoom = room.watchlist.filter((i) => !i.watched).length;

  const mineCount = Object.keys(userState?.wishlist ?? {}).length;

  /**
   * Пять пунктов, и «Вместе» третий — то есть ровно по центру дока.
   * Слева способы найти кино, справа — своё и люди.
   * Профиль в доке не нужен: он всегда доступен по аватару справа сверху.
   */
  const nav = [
    { key: VIEW.DECK, label: 'Кино', icon: Flame },
    { key: VIEW.COLLECTION, label: 'Каталог', icon: Library },
    { key: VIEW.ROOMS, label: 'Вместе', icon: Users, badge: room.onlineCount > 1 ? room.onlineCount : 0 },
    { key: VIEW.MINE, label: 'Моё', icon: Bookmark, badge: pendingInRoom || mineCount },
    // Вместо иконки — аватар: собственное лицо узнаётся быстрее пиктограммы.
    { key: VIEW.ME, label: 'Я', icon: UserRound, avatar: sessionUser?.photoURL ?? null },
  ];

  /*
   * На большом экране меню длиннее дока, и прятать разделы за
   * переключателями незачем: каталог и актёры разъезжаются в отдельные
   * пункты, «Вместе» встаёт сразу под лентой.
   */
  const desktopNav = [
    { key: VIEW.DECK, label: 'Кино', icon: Flame },
    { key: VIEW.ROOMS, label: 'Вместе', icon: Users, badge: room.onlineCount > 1 ? room.onlineCount : 0 },
    {
      key: 'collection-catalog', label: 'Каталог', icon: Library,
      current: view === VIEW.COLLECTION && collectionSection === 'catalog',
      onSelect: () => { setCollectionSection('catalog'); navigate(VIEW.COLLECTION); },
    },
    {
      key: 'collection-stars', label: 'Актёры', icon: Star,
      current: view === VIEW.COLLECTION && collectionSection === 'stars',
      onSelect: () => { setCollectionSection('stars'); navigate(VIEW.COLLECTION); },
    },
    { key: VIEW.MINE, label: 'Моё', icon: Bookmark, badge: pendingInRoom || mineCount },
  ];

  // На большом экране профиль и друзья — два отдельных пункта меню.
  const secondaryNav = [
    {
      key: 'me-friends', label: 'Друзья', icon: Users,
      current: view === VIEW.ME && meTab === 'friends',
      onSelect: () => { setMeTab('friends'); navigate(VIEW.ME); },
    },
    {
      key: 'me-profile', label: 'Профиль', icon: UserRound,
      current: view === VIEW.ME && meTab === 'profile',
      onSelect: () => { setMeTab('profile'); navigate(VIEW.ME); },
    },
  ];

  const deckPanel = (
    <SwipeDeck
      deck={deck}
      compact={deckMode === DECK_MODE.ROOM}
      roomProgress={deckMode === DECK_MODE.ROOM ? room.progress : null}
      roomMembers={deckMode === DECK_MODE.ROOM ? room.members : null}
      roomCode={deckMode === DECK_MODE.ROOM ? room.code : null}
      meUid={user?.uid}
      nearMatches={deckMode === DECK_MODE.ROOM ? room.nearMatches : []}
      onRefreshNear={deckMode === DECK_MODE.ROOM ? room.refreshNearMatches : null}
      /*
       * Согласие — это обычный голос «за», а не отдельная сущность.
       * Мэтч после него срабатывает тем же путём, что и всегда: правило
       * «сошлись все» не обходится, просто человеку показали, что от него
       * зависит развязка.
       */
      onAgreeNear={deckMode === DECK_MODE.ROOM ? (async (item) => {
        const title = item.title?.title ? item.title : { id: item.titleId };
        const result = await room.swipe(title, ACTION.LIKE);
        await room.refreshNearMatches();
        if (!result?.matched) {
          toasts.success('Ваш голос учтён — ждём остальных');
        }
      }) : null}
      onDecision={handleDecision}
      onRate={handleRate}
      askToRate={prefs.ratePrompt !== false}
      onNeverAskToRate={() => setPrefs((p) => ({ ...p, ratePrompt: false }))}
      onOpenDetails={setDetailsEntry}
      onOpenFilters={() => setFiltersOpen(true)}
      onRestart={actorDeck ? () => setActorDeck(null) : undefined}
      onUndo={handleUndo}
      canUndo={Boolean(lastDecision)}
      emptyArt="/mascot/empty.png"
      emptyTitle={actorDeck ? `Фильмы с ${actorDeck.name} закончились` : 'Колода закончилась'}
      emptyText={actorDeck
        ? 'Вернитесь в общую ленту или выберите другую звезду.'
        : 'Мы показали всё, что подходит под фильтры. Ослабьте их — и лента оживёт.'}
    />
  );

  /*
   * Экраны из renderView тоже бывают отложенными — оборачиваем результат
   * целиком, а не каждый по отдельности: одновременно виден ровно один.
   */
  const content = renderView({
    view, room, sessionUser, userState, taste, prefs, toasts, history, premium, friendIds,
    setView, setPrefs, setActorDeck, setRoomSession, setDetailsEntry, setPremiumOpen, setFeedbackOpen,
    focusPerson, createRoom, startActorDeck, handleToggleWatched,
    handleRemoveFavorite, handleUndoFromList, inviteFriendToWatch, auth,
    setEditorOpen, setShowcaseOpen, publicProfile, setPublicProfile, meTab, collectionSection,
    desktopShell: platform.shell === 'desktop',
    buildSharedDeck, deckBuilding, newsFrom, openNews,
  });


  const statusStrip = renderStatus({
    online, room, roomSession, deckMode, auth, pendingWrites,
    onOpenRoom: () => navigate(VIEW.ROOMS),
  });

  const navigate = (key) => { haptic('select'); setActorDeck(null); setView(key); };
  /*
   * Полоска встаёт в тот же слот, что и строка состояния: он для того
   * и существует — узкие сообщения над содержимым, которые не двигают
   * вёрстку экрана.
   */
  const shellProps = { active: view, onNavigate: navigate, user: sessionUser, online };

  return (
    /*
     * Вес и размер по умолчанию задаются один раз. Экран, которому нужна
     * иная иконка, переопределяет их у себя, но ряд кнопок больше
     * не разъезжается оттого, что кто-то поставил размер на глаз.
     */
    <IconContext.Provider value={{ size: ICON.md, weight: 'regular' }}>
    <ErrorBoundary name="app-root">
      <div className="aurora" data-mood={room.celebration ? 'match' : room.code ? 'room' : undefined} />
      <div className="app-root">
        {platform.shell === 'desktop' ? (
          <DesktopStudio
            {...shellProps}
            nav={desktopNav}
            secondaryNav={secondaryNav}
            onOpenProfile={() => navigate(VIEW.ME)}
            title={view === VIEW.COLLECTION && collectionSection === 'stars'
              ? 'Актёры'
              : TITLES[view] ?? 'MatchWatch'}
            subtitle={SUBTITLES({ view, room, actorDeck })}
            onLogout={auth.logout}
            actions={view === VIEW.DECK && (
              <div className="row gap-2">
                {/*
                  * Переключатель ленты был только на телефоне, и это
                  * недосмотр: на десктопе те же две ленты, и без него
                  * «Другое» нельзя включить вообще никак.
                  */}
                {deckMode === DECK_MODE.SOLO && (
                  <FeedModeSwitch value={feedMode} onChange={setFeedMode} />
                )}
                {/*
                  * `data-coach` — якорь для обучающих подсказок.
                  *
                  * Раньше они целились в класс `.hud__toolbar-right`,
                  * который есть только в телефонном шелле: на десктопе
                  * шаг про кубик и фильтры не показывал ни на что.
                  * Атрибут одинаков в обоих шеллах и не зависит от того,
                  * как эти кнопки оформлены.
                  */}
                <div className="row gap-2" data-coach="tools">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRouletteOpen(true)}>
                    <Dices size={16} /> Рулетка
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFiltersOpen(true)}>
                    <SlidersHorizontal size={16} /> Фильтры
                  </button>
                </div>
              </div>
            )}
          >
            {view === VIEW.DECK ? (
              <div className="cinema">
                <div className="cinema__deck">
                  {statusStrip}
                  {deckPanel}
                </div>
                <aside className="cinema__panel">
                  <DeckSidePanel deck={deck} room={room} taste={taste} />
                </aside>
              </div>
            ) : (
              <div className="studio__content">
                <Suspense fallback={<LoadingState text="Загружаем…" />}>{content}</Suspense>
              </div>
            )}
          </DesktopStudio>
        ) : (
          <MobileShell
            {...shellProps}
            nav={nav}
            scrollKey={view}
            fixed={view === VIEW.DECK}
            statusStrip={statusStrip}
            toolbar={view === VIEW.DECK && (
              <>
                {/* Переключатель по центру: он меняет саму ленту.
                    Инструменты при ней — прижаты к правому краю. */}
                {deckMode === DECK_MODE.SOLO
                  ? <FeedModeSwitch value={feedMode} onChange={setFeedMode} />
                  : <span />}
                <div className="row gap-2 hud__toolbar-right" data-coach="tools">
                  <button type="button" className="hud__pill" onClick={() => setRouletteOpen(true)} aria-label="Кино-рулетка">
                    <Dices size={16} />
                  </button>
                  <button type="button" className="hud__pill" onClick={() => setFiltersOpen(true)} aria-label="Фильтры">
                    <SlidersHorizontal size={16} />
                  </button>
                </div>
              </>
            )}
          >
            {view === VIEW.DECK
              ? deckPanel
              : <Suspense fallback={<LoadingState text="Загружаем…" />}>{content}</Suspense>}
          </MobileShell>
        )}

        <DeckCoach active={coachOpen} onDone={() => setCoachOpen(false)} />

        <Toasts toasts={toasts.toasts} onDismiss={toasts.dismiss} />

        {/* Один барьер на все отложенные оверлеи: они не показываются
            одновременно, и отдельный fallback для каждого только плодил бы
            мигающие заглушки. */}
        <Suspense fallback={null}>
        <ProfileEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          uid={user?.uid}
          profile={userState?.profile}
          toasts={toasts}
          onSaved={(saved) => setUserState((prev) => (prev ? { ...prev, profile: saved ?? prev.profile } : prev))}
        />

        <ShowcaseEditor
          open={showcaseOpen}
          onClose={() => setShowcaseOpen(false)}
          uid={user?.uid}
          profile={userState?.profile}
          favorites={userState?.favorites ?? {}}
          toasts={toasts}
          premium={premium.premium}
          onOpenPremium={() => { setShowcaseOpen(false); setPremiumOpen(true); }}
          onSaved={(saved) => setUserState((prev) => (prev ? { ...prev, profile: saved ?? prev.profile } : prev))}
        />

        <NewsScreen
          item={announced}
          onClose={() => { markNewsSeen(announced); setAnnounced(null); }}
          onAction={() => {
            markNewsSeen(announced);
            setAnnounced(null);
            // Объявление про подписку ведёт в витрину: она и есть ответ
            // на вопрос «что нового», лишний экран между ними — трение.
            if (announced?.action === 'premium') setPremiumOpen(true);
            else openNews(VIEW.ME);
          }}
          onOpenAll={() => { markNewsSeen(announced); setAnnounced(null); openNews(VIEW.ME); }}
        />

        <FeedbackSheet
          open={feedbackOpen}
          onClose={() => setFeedbackOpen(false)}
          uid={user?.uid}
          /* Экран подставляем сами: он объясняет отзыв лучше любой темы. */
          screen={view}
          toasts={toasts}
        />

        <PremiumSheet
          open={premiumOpen}
          onClose={() => setPremiumOpen(false)}
          premium={premium.premium}
          promoAvailable={premium.promoAvailable}
          daysLeft={premium.daysLeft}
          busy={premium.busy}
          onActivate={premium.activatePromo}
          onPurchase={premium.purchase}
          toasts={toasts}
        />

        <DetailsSheet
          open={Boolean(detailsEntry)}
          entry={detailsEntry}
          onClose={() => setDetailsEntry(null)}
          onOpenActor={(personId) => { setDetailsEntry(null); setFocusPerson(personId); setView(VIEW.COLLECTION); }}
          onToggleWatched={handleToggleWatched}
          onToggleLike={(title) => handleToggleDecision(title, ACTION.FAVORITE)}
          isLiked={detailsEntry ? history[detailsEntry.title.id] === ACTION.FAVORITE : false}
          onToggleWish={(title) => handleToggleDecision(title, ACTION.LATER)}
          isWished={detailsEntry ? history[detailsEntry.title.id] === ACTION.LATER : false}
          isWatched={detailsEntry ? history[detailsEntry.title.id] === 'watched' : false}
          rating={detailsEntry ? (userState?.ratings?.[detailsEntry.title.id]?.rating ?? null) : null}
          onRate={handleRate}
          /*
           * Чего хотели сегодня — из своего же запроса, а не из чужих:
           * объяснение адресовано тому, кто открыл карточку.
           */
          wanted={room.myMood?.ai?.summary ?? null}
        />

        <FiltersSheet
          open={filtersOpen}
          value={filters}
          onClose={() => setFiltersOpen(false)}
          onApply={(next) => { setFilters(next); setActorDeck(null); }}
        />

        <RouletteModal
          open={rouletteOpen}
          onClose={() => setRouletteOpen(false)}
          pool={deckPoolRef.current}
          history={history}
          taste={taste}
          onPick={(title) => setDetailsEntry({ id: title.id, title, matchedTags: [] })}
        />

        {room.celebration && (
          <MatchCelebration
            match={room.celebration}
            roomCode={room.code}
            partners={room.members.filter((m) => m.uid !== user?.uid)}
            friendIds={friendIds}
            meUid={user?.uid}
            onClose={room.dismissCelebration}
            onOpenWatchlist={() => { room.dismissCelebration(); setView(VIEW.MINE); }}
            /*
             * Комнату заводят, чтобы выбрать фильм. Фильм выбран — она
             * своё отработала, и держать её открытой значит копить
             * мёртвые комнаты, в которые никто не вернётся.
             */
            onFinish={async () => {
              const done = await room.finishAfterMatch();
              setView(VIEW.MINE);
              toasts.success(done
                ? 'Комната завершена — фильм ждёт в списке'
                : 'Фильм в списке');
            }}
          />
        )}
        </Suspense>
      </div>
    </ErrorBoundary>
    </IconContext.Provider>
  );
}

const TITLES = {
  [VIEW.DECK]: 'Лента',
  [VIEW.COLLECTION]: 'Каталог',
  [VIEW.ROOMS]: 'Смотрим вместе',
  [VIEW.MINE]: 'Моё',
  [VIEW.ME]: 'Я',
  [VIEW.PUBLIC_PROFILE]: 'Профиль',
  [VIEW.SETTINGS]: 'Настройки',
  [VIEW.DASHBOARD]: 'Метрики',
};

const SUBTITLES = ({ view, room, actorDeck }) => {
  if (view === VIEW.DECK && actorDeck) return `Только фильмы: ${actorDeck.name}`;
  if (view === VIEW.DECK && room.code) return `Комната ${room.code} · ${room.onlineCount} в сети`;
  if (view === VIEW.DECK) return 'Свайпайте: вправо — нравится, влево — мимо';
  return null;
};

function renderView(ctx) {
  const {
    view, room, sessionUser, userState, taste, prefs, toasts, history, premium, friendIds,
    setView, setPrefs, setRoomSession, setDetailsEntry, setActorDeck, setPremiumOpen, setFeedbackOpen,
    focusPerson, createRoom, startActorDeck, handleToggleWatched,
    handleRemoveFavorite, handleUndoFromList, inviteFriendToWatch, auth,
    setEditorOpen, setShowcaseOpen, publicProfile, setPublicProfile, meTab, collectionSection,
    desktopShell, buildSharedDeck, deckBuilding, newsFrom, openNews,
  } = ctx;

  const openDetails = (stub) => setDetailsEntry({
    id: stub.id ?? stub.titleId, title: stub, matchedTags: [],
  });

  switch (view) {
    case VIEW.ROOMS:
      return (
        <RoomsView
          room={room}
          user={sessionUser}
          friendIds={friendIds}
          toasts={toasts}
          onCreate={createRoom}
          onEnterRoom={() => { setRoomSession(true); setActorDeck(null); setView(VIEW.DECK); }}
          onOpenMember={(member) => { setPublicProfile(member); setView(VIEW.PUBLIC_PROFILE); }}
          onBuildDeck={buildSharedDeck}
          deckBuilding={deckBuilding}
        />
      );

    case VIEW.COLLECTION:
      return (
        <CollectionView
          key={collectionSection}
          initialSection={collectionSection}
          showTabs={!desktopShell}
          catalog={{ onOpenTitle: openDetails, history }}
          stars={{ onStartActorDeck: startActorDeck, onOpenTitle: openDetails, initialPersonId: focusPerson }}
        />
      );

    case VIEW.MINE:
      return (
        <VaultView
          room={room.code ? room : null}
          favorites={userState?.favorites ?? {}}
          watched={userState?.watched ?? {}}
          wishlist={userState?.wishlist ?? {}}
          ratings={userState?.ratings ?? {}}
          matches={userState?.matches ?? {}}
          onOpenTitle={openDetails}
          onRemoveFavorite={handleRemoveFavorite}
          onUndoDecision={handleUndoFromList}
        />
      );

    case VIEW.PUBLIC_PROFILE:
      return (
        <PublicProfileView
          onOpenPremium={() => setPremiumOpen(true)}
          onInviteToRoom={inviteFriendToWatch}
          username={typeof publicProfile === 'string' ? publicProfile : null}
          userId={typeof publicProfile === 'object' ? publicProfile?.uid : null}
          toasts={toasts}
          onOpenTitle={openDetails}
          onEditShowcase={() => setShowcaseOpen(true)}
          onBack={() => setView(publicProfile?.uid ? VIEW.ROOMS : VIEW.ME)}
        />
      );

    case VIEW.ME:
      return (
        <MeView
          key={meTab}
          initialTab={meTab}
          showTabs={!desktopShell}
          user={sessionUser}
          profile={userState?.profile}
          onOpenTitle={openDetails}
          onEditShowcase={() => setShowcaseOpen(true)}
          onOpenSettings={() => setView(VIEW.SETTINGS)}
          premium={premium}
          onOpenPremium={() => setPremiumOpen(true)}
          onOpenPublicProfile={(username) => { setPublicProfile(username); setView(VIEW.PUBLIC_PROFILE); }}
          toasts={toasts}
        />
      );

    case VIEW.SETTINGS:
      return (
        <SettingsView
          profile={userState?.profile}
          access={userState?.access}
          prefs={prefs}
          premium={premium}
          onBack={() => setView(VIEW.ME)}
          onEditProfile={() => setEditorOpen(true)}
          onEditShowcase={() => setShowcaseOpen(true)}
          onOpenPremium={() => setPremiumOpen(true)}
          onOpenDashboard={() => setView(VIEW.DASHBOARD)}
          onPrefsChange={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
          onLogout={auth.logout}
          onOpenFeedback={() => setFeedbackOpen(true)}
          onOpenNews={() => openNews(VIEW.SETTINGS)}
          toasts={toasts}
        />
      );

    case VIEW.NEWS:
      return (
        <WhatsNewView
          onBack={() => setView(newsFrom)}
          onOpenPremium={() => setPremiumOpen(true)}
          onOpenFeedback={() => setFeedbackOpen(true)}
        />
      );

    case VIEW.DASHBOARD:
      return <DashboardView onBack={() => setView(VIEW.ME)} />;

    default:
      // Лента рисуется шеллом напрямую — сюда попадать не должны.
      return null;
  }
}

/** Строка состояния: сеть, комната, режим колоды. Молчание — худший UX. */
function renderStatus({ online, room, roomSession, deckMode, auth, pendingWrites, onOpenRoom }) {
  /*
   * У каждой строки свой ключ: он же ключ React-элемента. Смена ключа
   * пересоздаёт компонент, а вместе с ним и состояние «закрыто» —
   * иначе однажды скрытое уведомление не показалось бы и тогда,
   * когда случилось что-то новое.
   */
  if (!online) {
    return (
      <StatusStrip key="offline" tone="error" dismissible={false}>
        Нет соединения. Отметки сохраняются и уедут в базу, когда сеть вернётся.
      </StatusStrip>
    );
  }

  // Сеть есть, но что-то ещё не доехало — честно показываем, а не молчим.
  if (pendingWrites > 0) {
    return (
      <StatusStrip key="pending" tone="warn" dismissible={false}>
        Досылаем {pendingWrites} {pendingWrites === 1 ? 'отметку' : 'отметок'} в базу…
      </StatusStrip>
    );
  }
  if (auth.isDegraded) {
    return <StatusStrip key="degraded" tone="warn">{auth.error?.text}</StatusStrip>;
  }
  if (room.error) {
    return <StatusStrip key={`room-error:${room.error.message}`} tone="error">{room.error.message}</StatusStrip>;
  }
  if (deckMode === 'room' && roomSession) {
    return (
      <StatusStrip
        key={`room:${room.code}`}
        tone="live"
        action={{ label: 'В комнату', onClick: onOpenRoom }}
      >
        Комната {room.code} · {room.onlineCount} в сети · общая колода
      </StatusStrip>
    );
  }
  return null;
}

/** Правая колонка десктопа: контекст текущей карточки без модалок. */
function DeckSidePanel({ deck, room, taste }) {
  const entry = deck.current;
  if (!entry) return null;
  const title = entry.title;

  return (
    <>
      <section className="taste-panel">
        <span className="eyebrow">Сейчас на экране</span>
        <h2 className="section__title">{title.title}</h2>
        {title.overview && <p className="details__overview clamp-3">{title.overview}</p>}
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          {(title.genres ?? []).map((g) => <span className="chip" key={g}>{g}</span>)}
        </div>
      </section>

      {/*
        * Здесь сравнивались вектор человека и вектор фильма. Первого
        * больше нет: он усреднял весь вкус в одну точку между любимыми
        * фильмами, и сравнивать с ним было бессмысленно — совпадение
        * с серединой ничего не говорит о том, стоит ли смотреть.
        *
        * Настроение самого фильма осталось и показывается там, где оно
        * к месту, — в карточке деталей.
        */}
      {title.moods && (
        <section className="taste-panel">
          <span className="eyebrow">Настроение фильма</span>
          <MoodBars vector={title.moods} />
        </section>
      )}
    </>
  );
}
