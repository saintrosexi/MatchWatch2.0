import { useState } from 'react';
import { Send } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { sendFeedback } from '../../engine/social.js';
import { haptic } from '../../lib/telegram.js';

/**
 * Написать нам.
 *
 * Одно поле и одна кнопка — больше ничего. Ни темы, ни оценки, ни
 * категории: каждое такое поле отсекает часть тех, кто собирался
 * написать, а на этой стадии дорог каждый отзыв. Экран, версию
 * и платформу подставляем сами, у человека их не спрашиваем.
 *
 * Отправленное не редактируется и не показывается обратно списком.
 * Это не переписка: человек сказал — мы услышали и ответим сами,
 * если будет чем.
 */
export function FeedbackSheet({ open, onClose, uid, screen, toasts }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || text.trim().length < 2) return;
    setBusy(true);
    try {
      await sendFeedback(text, { uid, screen });
      haptic('success');
      toasts?.success?.('Спасибо — прочитаем всё');
      setText('');
      onClose?.();
    } catch (error) {
      toasts?.error?.(error?.message ?? 'Не отправилось. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Написать нам">
      <form className="stack gap-4" onSubmit={submit}>
        <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          Что мешает, что раздражает, чего не хватает. Сейчас продукт
          меняется от одного внятного отзыва сильнее, чем от недели графиков,
          — поэтому пишите как есть, без вежливости.
        </p>

        <textarea
          className="input"
          rows={5}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Например: не понял, зачем свайпать вверх"
          aria-label="Текст сообщения"
          style={{ resize: 'vertical', minHeight: 120, lineHeight: 1.5 }}
        />

        <button
          type="submit"
          className="btn btn--primary btn--block btn--lg"
          disabled={busy || text.trim().length < 2}
        >
          <Send size={16} /> {busy ? 'Отправляем…' : 'Отправить'}
        </button>

        <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
          Мы увидим, с какого экрана и с какой версии пришло сообщение —
          спрашивать это у вас незачем.
        </p>
      </form>
    </Sheet>
  );
}
