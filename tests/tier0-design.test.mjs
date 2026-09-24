/**
 * Уровень 0 — статические проверки дизайна.
 *
 * Проверяет соответствие кода спецификации дизайна: запреты на градиенты
 * текста, на второстепенные цвета, на неправильные размеры шрифта, на
 * множественные радиусы скругления, на декоративные элементы, на emoji,
 * на трансформации при наведении, на тени где они не нужны, и на
 * анимации, вызванные скроллом.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Вспомогательная функция для рекурсивного обхода директории
 * и сбора файлов с нужными расширениями.
 */
const walk = (dir, exts = ['.css', '.jsx', '.js']) => {
  const result = [];
  const walkDir = (d) => {
    try {
      const entries = readdirSync(d);
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = join(d, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walkDir(full);
        } else if (exts.some((ext) => name.endsWith(ext))) {
          result.push(full);
        }
      }
    } catch (e) {
      // Skip inaccessible directories
    }
  };
  walkDir(dir);
  return result;
};

/**
 * Вспомогательная функция для разбора линий файла с номерами.
 */
const lines = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').map((text, i) => ({
      file,
      line: i + 1,
      text,
    }));
  } catch (e) {
    return [];
  }
};

test('D1 · нет градиентного текста (background-clip: text)', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']));

  const offenders = cssFiles.flatMap((file) =>
    lines(file)
      .filter(({ text }) =>
        /background-clip\s*:\s*text|webkit-background-clip\s*:\s*text/i.test(text)
        && !text.trimStart().startsWith('*')
        && !text.trimStart().startsWith('//'),
      )
      .map(({ line }) => `${file}:${line}`),
  );

  assert.deepEqual(offenders, [],
    `градиентный текст (запрет дизайна):\n  ${offenders.join('\n  ')}`);
});

/*
 * Личные акценты профиля — выбор человека в редакторе, а не цвета
 * интерфейса. Правило «один акцент» их не касается; см. views.css.
 */
const PERSONAL_ACCENT = /\.profile-page\[data-accent=|\{ key: '(gold|ice|mint|violet)', label:/;

test('D2 · нет фиолетового цвета (--violet, #a97bff)', async () => {
  const files = walk('src/styles', ['.css'])
    .concat(walk('src/welcome', ['.css']))
    .concat(walk('src', ['.jsx', '.js']));

  const offenders = files.flatMap((file) =>
    lines(file)
      .filter(({ text }) =>
        (/--violet|#a97bff|169,\s*123,\s*255/i.test(text) || /rgba\(\s*169\s*,\s*123\s*,\s*255/.test(text))
        && !PERSONAL_ACCENT.test(text)
        && !text.trimStart().startsWith('*')
        && !text.trimStart().startsWith('//'),
      )
      .map(({ line }) => `${file}:${line}`),
  );

  assert.deepEqual(offenders, [],
    `фиолетовый цвет (запрет дизайна):\n  ${offenders.join('\n  ')}`);
});

test('D3 · шкала типографики (var(--t-*), без clamp)', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']));
  const jsxFiles = walk('src', ['.jsx']);

  // Проверка CSS: кроме tokens.css, все font-size должны использовать var(--t-*)
  const cssOffenders = cssFiles.flatMap((file) => {
    if (file.endsWith('tokens.css')) return []; // Skip token definitions
    return lines(file)
      .filter(({ text }) => {
        if (text.trimStart().startsWith('*') || text.trimStart().startsWith('//')) return false;
        // Check for font-size with raw values or clamp
        // `max(16px, var(--t-…))` у полей ввода — не произвольный размер,
        // а защита от автозума iOS на фокусе.
        return /font-size\s*:\s*(?!\s|var\(--t-|max\(16px,\s*var\(--t-)[^;]+/.test(text);
      })
      .map(({ line }) => `${file}:${line}`);
  });

  // Проверка JSX: fontSize должно быть строкой с var(--t-*)
  const jsxOffenders = jsxFiles.flatMap((file) =>
    lines(file)
      .filter(({ text }) => {
        if (text.trimStart().startsWith('//')) return false;
        // Check for fontSize not using var(--t-*)
        // `(?!\s|…)`: без этого `\s*` отступает на пробел назад, и проверка
        // срабатывает на правильном `fontSize: 'var(--t-small)'`.
        return /fontSize\s*[:=]\s*(?!\s|['"`]var\(--t-)/i.test(text);
      })
      .map(({ line }) => `${file}:${line}`),
  );

  const allOffenders = [...cssOffenders, ...jsxOffenders];
  assert.deepEqual(allOffenders, [],
    `неправильный размер шрифта (только var(--t-*)):\n  ${allOffenders.join('\n  ')}`);
});

test('D4 · один радиус (var(--r), 50%, inherit, 0 или комбинация)', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']));
  const jsxFiles = walk('src', ['.jsx']);

  // CSS check
  const cssOffenders = cssFiles.flatMap((file) => {
    if (file.endsWith('tokens.css')) return [];
    return lines(file)
      .filter(({ text }) => {
        if (text.trimStart().startsWith('*') || text.trimStart().startsWith('//')) return false;
        if (!/border-radius\s*:/.test(text)) return false;
        // Allow: var(--r), 50%, inherit, 0, combinations like "var(--r) var(--r) 0 0", --lens-r
        return !/border-radius\s*:\s*(var\(--r\)|50%|inherit|0|var\(--lens-r|var\(--r\)\s+var\(--r\)\s+0\s+0|var\(--r\)\s+var\(--r\)\s+var\(--r\)\s+0|0\s+var\(--r\)|var\(--r\)\s+0)[^;]*;/.test(text);
      })
      .map(({ line }) => `${file}:${line}`);
  });

  // JSX check for borderRadius
  const jsxOffenders = jsxFiles.flatMap((file) =>
    lines(file)
      .filter(({ text }) => {
        if (text.trimStart().startsWith('//')) return false;
        if (!/borderRadius\s*[:=]/.test(text)) return false;
        // Should be a var(--r) string or a simple value
        // Тернарник из разрешённых значений (`rounded ? 'inherit' : 0`) — тоже норма.
        const ok = `(?:'var\\(--r\\)'|'50%'|'inherit'|0)`;
        if (new RegExp(`borderRadius\\s*:\\s*[\\w.]+\\s*\\?\\s*${ok}\\s*:\\s*${ok}`).test(text)) return false;
        return !/borderRadius\s*[:=]\s*['"`]?(var\(--r\)|50%|inherit|0|--lens-r|['"`]$)/.test(text);
      })
      .map(({ line }) => `${file}:${line}`),
  );

  const allOffenders = [...cssOffenders, ...jsxOffenders];
  assert.deepEqual(allOffenders, [],
    `неправильный радиус (только var(--r), 50%, inherit, 0):\n  ${allOffenders.join('\n  ')}`);
});

test('D5 · один акцент (без --gold, --ice, --mint, --acid-red, --coral-hot)', async () => {
  const files = walk('src/styles', ['.css'])
    .concat(walk('src/welcome', ['.css']))
    .concat(walk('src', ['.jsx', '.js']))
    .filter((f) => !f.endsWith('tokens.css')); // tokens.css can define these as aliases

  const forbiddenColors = [
    '--gold',
    '--ice',
    '--mint',
    '--acid-red',
    '--coral-hot',
    '--grad-',
    '--glow-',
    '#ffc24b', // gold hex
    '255,\\s*194,\\s*75', // gold rgb
    '#6fd8ff', // ice hex
    '111,\\s*216,\\s*255', // ice rgb
  ];

  const pattern = new RegExp(forbiddenColors.join('|'), 'i');

  const offenders = files.flatMap((file) =>
    lines(file)
      .filter(({ text }) =>
        pattern.test(text)
        && !PERSONAL_ACCENT.test(text)
        && !text.trimStart().startsWith('*')
        && !text.trimStart().startsWith('//'),
      )
      .map(({ line }) => `${file}:${line}`),
  );

  assert.deepEqual(offenders, [],
    `недопустимый цвет (только --accent, --danger, --success):\n  ${offenders.join('\n  ')}`);
});

test('D6 · нет блобов и декоративных форм (.aurora)', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']));
  const jsxFiles = walk('src', ['.jsx']);

  const cssOffenders = cssFiles.flatMap((file) =>
    lines(file)
      .filter(({ text }) =>
        /\.aurora|className\s*=\s*["']aurora/.test(text)
        && !text.trimStart().startsWith('*')
        && !text.trimStart().startsWith('//'),
      )
      .map(({ line }) => `${file}:${line}`),
  );

  const jsxOffenders = jsxFiles.flatMap((file) =>
    lines(file)
      .filter(({ text }) =>
        /className\s*=\s*["'].*aurora/.test(text)
        && !text.trimStart().startsWith('//'),
      )
      .map(({ line }) => `${file}:${line}`),
  );

  const allOffenders = [...cssOffenders, ...jsxOffenders];
  assert.deepEqual(allOffenders, [],
    `блобы и декоративные элементы (запрет дизайна):\n  ${allOffenders.join('\n  ')}`);
});

test('D7 · нет emoji в пользовательском интерфейсе', async () => {
  const files = walk('src', ['.jsx', '.js'])
    .concat(walk('api', ['.js']))
    .filter((f) => !f.endsWith('rooms.js')); // rooms.js is allow-listed

  // Emoji ranges: U+1F300–U+1FAFF (main), U+2600–U+27BF, U+2B50, U+2728
  const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2728}]/gu;

  const offenders = files.flatMap((file) =>
    lines(file)
      .filter(({ text }) => {
        // Skip comment lines
        if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*') || text.trimStart().startsWith('/*')) {
          return false;
        }
        return emojiPattern.test(text);
      })
      .map(({ line }) => `${file}:${line}`),
  );

  assert.deepEqual(offenders, [],
    `emoji в интерфейсе (запрет дизайна):\n  ${offenders.join('\n  ')}`);
});

test('D8 · нет трансформаций при наведении (:hover transform)', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']));

  const offenders = [];

  for (const file of cssFiles) {
    const content = readFileSync(file, 'utf8');
    // Simple CSS rule parsing: find :hover selectors and check if their block contains transform/translate/scale
    const hoverRulePattern = /([^{]+:hover[^{]*)\{([^}]+)\}/g;
    let match;
    const lines_arr = content.split('\n');
    let lineNum = 1;
    let lastPos = 0;

    while ((match = hoverRulePattern.exec(content)) !== null) {
      const ruleContent = match[2];
      if (/transform|translate|scale|box-shadow/i.test(ruleContent)) {
        // Find the line number
        const beforeMatch = content.substring(0, match.index);
        lineNum = beforeMatch.split('\n').length;
        offenders.push(`${file}:${lineNum}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `трансформация при наведении (запрет дизайна):\n  ${offenders.join('\n  ')}`);
});

test('D9 · нет transition: all в CSS', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']));

  const offenders = cssFiles.flatMap((file) =>
    lines(file)
      .filter(({ text }) =>
        /transition\s*:\s*all/.test(text)
        && !text.trimStart().startsWith('*')
        && !text.trimStart().startsWith('//'),
      )
      .map(({ line }) => `${file}:${line}`),
  );

  assert.deepEqual(offenders, [],
    `transition: all (запрет дизайна, используй конкретные свойства):\n  ${offenders.join('\n  ')}`);
});

test('D10 · тени только на плавающих слоях', async () => {
  const cssFiles = walk('src/styles', ['.css']).concat(walk('src/welcome', ['.css']))
    .filter((f) => !f.endsWith('tokens.css') && !f.endsWith('glass.css') && !f.endsWith('welcome.css'));

  // coach__hole — не тень поверхности, а затемнение всего экрана вокруг подсказки.
  const floatingSelectors = /sheet|toast|menu|popover|modal|dialog|coach__hole/i;

  const offenders = cssFiles.flatMap((file) => {
    const content = readFileSync(file, 'utf8');
    // Parse CSS rules: look for box-shadow outside floating layers
    const lines_arr = content.split('\n');
    let inRule = false;
    let currentSelector = '';
    let offenderLines = [];

    for (let i = 0; i < lines_arr.length; i++) {
      const line = lines_arr[i];
      const text = line.trim();

      if (text.includes('{') && !text.includes('}')) {
        // Start of rule
        currentSelector = text.substring(0, text.indexOf('{')).trim();
        inRule = true;
      } else if (text.includes('}')) {
        inRule = false;
        currentSelector = '';
      }

      if (inRule && /box-shadow\s*:/.test(line)) {
        // Check if it's 'none' (allowed everywhere)
        if (/box-shadow\s*:\s*none/.test(line)) {
          continue;
        }
        // Check if selector matches floating pattern
        if (!floatingSelectors.test(currentSelector)) {
          offenderLines.push(i + 1);
        }
      }
    }

    return offenderLines.map((line) => `${file}:${line}`);
  });

  assert.deepEqual(offenders, [],
    `тень вне плавающего слоя (запрет дизайна):\n  ${offenders.join('\n  ')}`);
});

test('D11 · нет анимации, вызванной скроллом', async () => {
  const files = walk('src', ['.jsx', '.js']);

  const offenders = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const fileLines = content.split('\n');

    fileLines.forEach((line, idx) => {
      if (line.trimStart().startsWith('//')) return;
      if (/IntersectionObserver|animation-timeline|view-timeline|data-aos/.test(line)) {
        offenders.push(`${file}:${idx + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    `анимация, вызванная скроллом (запрет дизайна):\n  ${offenders.join('\n  ')}`);
});

test('D12 · /welcome использует настоящие скриншоты', async () => {
  // Витрина лежит в корне репозитория. Нет файла — это провал, а не пропуск:
  // иначе проверка молча «проходит», ничего не проверив.
  const welcomeContent = readFileSync(new URL('../welcome.html', import.meta.url), 'utf8');

  // Check 1: no class="phone"
  const hasPhoneMock = /class\s*=\s*["'][^"']*phone/.test(welcomeContent);
  assert.ok(!hasPhoneMock, 'найден CSS-нарисованный телефон (запрет дизайна)');

  // Check 2: at least one <img> with src starting with /screens/
  const hasRealScreenshot = /<img[^>]*src\s*=\s*["']\/?screens\//.test(welcomeContent);
  assert.ok(hasRealScreenshot, 'нет скриншотов настоящего приложения (используй /screens/)');
});
