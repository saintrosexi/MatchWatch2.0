# Тексты для BotFather и каталогов мини-приложений

## BotFather

Описание и короткое описание выставляются кодом
(`api/_lib/botSetup.js → BOT_DESCRIPTION`, `BOT_SHORT_DESCRIPTION`) при
вызове `POST /api/telegram/setup`. Править — там, а не в BotFather:
иначе следующая настройка перезапишет.

Руками в BotFather остаётся:

1. `/mybots` → бот → **Bot Settings → Configure Mini App → Enable Main Mini App**.
2. **Preview media** — 3–5 вертикальных скриншотов: лента с карточкой,
   комната с участниками, празднование мэтча, профиль с «паутинкой» вкуса.
   Плюс видео 10–15 секунд: свайп → свайп → мэтч с конфетти.
3. **Edit Botpic** — `public/brand/matchwatch-avatar-512.png`.

---

## Telegram Apps Center (`@tapps_bot`) и FindMini

> Ссылка в заявке: `https://t.me/MatchWatchApp_bot/app?startapp=src_tapps`
> (для FindMini — `src_findmini`).

**Название:** MatchWatch

**Категория:** Entertainment / Развлечения

**Короткое описание (до 100 знаков):**
Свайпайте фильмы вдвоём — приложение покажет, на чём вы совпали.

**Полное описание:**
MatchWatch помогает паре или компании выбрать фильм за пять минут.
Каждый свайпает кино у себя в телефоне: вправо — «хочу», влево — «мимо».
Когда все захотели один и тот же фильм — это мэтч, с конфетти.

• Совместные комнаты до восьми человек: код или ссылка прямо в чат.
• Рекомендации по темам, а не по жанрам, с объяснением под каждой карточкой.
• Весь каталог TMDB с фильтрами, страницы актёров, кино-рулетка.
• Только вышедшие фильмы — всё можно включить сегодня.

Бесплатно. Premium снимает лимит комнат и открывает оформление профиля.

**English (для каталогов, которые требуют):**
MatchWatch is a Tinder-style movie picker for couples and friends. Everyone
swipes on their own phone; when you all like the same film, it's a match.
Recommendations follow themes you love, not just genres. Russian UI.

**Иконка:** `public/brand/matchwatch-avatar-512.png`
**Обложка:** `public/brand/og-1200x630.png`
