/**
 * Единая точка для иконок.
 *
 * Раньше каждый экран импортировал их напрямую и назначал размер на глаз —
 * по проекту разошлось шестнадцать разных значений, и ряды кнопок читались
 * как случайные. Здесь имена привязаны к смыслу, а не к рисунку: если
 * когда-нибудь поменяется набор, правится один файл, а не двадцать восемь.
 *
 * Имена сохранены прежними намеренно. Переезд на другой набор не должен
 * заодно переписывать разметку — иначе в одном изменении смешиваются
 * смена стиля и правка вёрстки, и разобрать потом нечего.
 *
 * Заливка задаётся весом (`weight="fill"`), а не подменой fill/stroke:
 * у сплошной иконки своя отрисовка, а закрашенный контур выглядит
 * тяжелее соседей по ряду.
 */

export {
  Warning as AlertTriangle,
  WarningCircle as AlertCircle,
  Copy,
  DoorOpen,
  Fire as Flame,
  Books as Library,
  SignIn as LogIn,
  Plus,
  ArrowLeft,
  At as AtSign,
  ChartBar as BarChart3,
  BookmarkSimple as Bookmark,
  BookmarkSimple as BookmarkX,
  Check,
  CheckCircle as CheckCircle2,
  FilmSlate as Clapperboard,
  Clock,
  Compass,
  Crown,
  DiceFive as Dices,
  DownloadSimple as Download,
  Eye,
  EyeSlash as EyeOff,
  FilmReel as Film,
  Heart,
  HeartBreak as HeartOff,
  Image,
  Info,
  Key as KeyRound,
  Link as Link2,
  LinkBreak as Link2Off,
  CircleNotch as Loader2,
  SignOut as LogOut,
  Confetti as PartyPopper,
  PencilSimple as Pencil,
  Play,
  ArrowsClockwise as RefreshCw,
  ArrowCounterClockwise as RotateCcw,
  Gear as Settings,
  Lock,
  MagnifyingGlass as Search,
  PaperPlaneTilt as Send,
  ShareNetwork as Share2,
  SlidersHorizontal,
  Sparkle as Sparkles,
  Wrench,
  Star,
  Trash as Trash2,
  UserMinus,
  UserPlus,
  User as UserRound,
  UsersThree as Users,
  Vibrate,
  SpeakerHigh as Volume2,
  SpeakerX as VolumeX,
  WifiSlash as WifiOff,
  X,
} from '@phosphor-icons/react';

export { IconContext } from '@phosphor-icons/react';

/**
 * Шкала размеров. Пять ступеней покрывают весь проект — шестнадцать
 * произвольных значений не покрывали ничего, кроме привычки автора.
 *
 *   xs — метки внутри бейджей и подписей
 *   sm — иконка в строке текста и в мелкой кнопке
 *   md — обычная кнопка, пункт навигации
 *   lg — крупное действие
 *   hero — пустые состояния, где иконка работает картинкой
 */
export const ICON = Object.freeze({
  xs: 12,
  sm: 16,
  md: 20,
  lg: 26,
  hero: 44,
});
