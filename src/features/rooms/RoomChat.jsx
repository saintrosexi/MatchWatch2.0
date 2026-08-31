import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, X } from '../../ui/icons.js';
import {
  ROOM_REACTIONS, loadRoomMessages, sendRoomMessage, subscribeRoomMessages,
} from '../../engine/rooms.js';
import { haptic } from '../../lib/telegram.js';

/**
 * Короткий разговор внутри комнаты.
 *
 * Свёрнут по умолчанию и остаётся полосой в одну строку — это главное
 * требование к нему. Двое пришли выбирать кино, а не переписываться;
 * блок, который занимает место и просит внимания, мешает ровно тому,
 * ради чего комнату и создали.
 *
 * Реакции стоят первыми, поле ввода — вторым и намеренно узким.
 * «Давай это» и «а может другое» закрывают почти всё, что нужно сказать
 * при выборе фильма, и стоят одного касания. Полноценным мессенджером
 * это становиться не должно: как только здесь появится история,
 * непрочитанные и уведомления, продукт станет другим.
 *
 * Свёрнутая полоса показывает последнее сообщение: без него человек
 * не узнает, что ему написали, а разворачивать блок на всякий случай
 * никто не станет.
 */
export function RoomChat({ code, uid, members = [], placement = 'lobby' }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);

  const nameOf = useCallback((id) => {
    if (id === uid) return 'вы';
    return members.find((m) => m.uid === id)?.name ?? 'партнёр';
  }, [members, uid]);

  useEffect(() => {
    if (!code) return undefined;
    let alive = true;

    loadRoomMessages(code)
      .then((rows) => { if (alive) setMessages(rows); })
      .catch(() => { /* переписка — не условие работы комнаты */ });

    const stop = subscribeRoomMessages(code, (row) => {
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
    });

    return () => { alive = false; stop(); };
  }, [code]);

  /* Свежее сообщение должно быть видно сразу, без прокрутки руками. */
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, messages.length]);

  const send = async (kind, body) => {
    if (busy || !body.trim()) return;
    setBusy(true);
    haptic('light');
    try {
      const row = await sendRoomMessage(code, { kind, body, uid });
      /*
       * Своё сообщение добавляем сами, не дожидаясь эха от базы:
       * иначе между касанием и появлением строки видна задержка сети,
       * и человек жмёт второй раз.
       */
      if (row) setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      setDraft('');
    } catch {
      /* Молча: несостоявшаяся реакция — не повод пугать посреди выбора. */
    } finally {
      setBusy(false);
    }
  };

  const last = messages[messages.length - 1];

  if (!open) {
    return (
      <button
        type="button"
        className="room-chat__bar"
        data-placement={placement}
        onClick={() => setOpen(true)}
      >
        <span className="room-chat__bar-icon">💬</span>
        <span className="room-chat__bar-text truncate">
          {last
            ? `${nameOf(last.user_id)}: ${last.body}`
            : PROMPT[placement] ?? PROMPT.lobby}
        </span>
      </button>
    );
  }

  return (
    <section className="room-chat" aria-label="Разговор в комнате">
      <div className="room-chat__head">
        <span className="room-chat__title">В комнате</span>
        <button type="button" aria-label="Свернуть" onClick={() => setOpen(false)}>
          <X size={16} />
        </button>
      </div>

      {messages.length > 0 && (
        <div className="room-chat__list" ref={listRef}>
          {messages.map((m) => (
            <p className="room-chat__line" key={m.id} data-mine={m.user_id === uid}>
              <b>{nameOf(m.user_id)}</b> {m.body}
            </p>
          ))}
        </div>
      )}

      <div className="room-chat__reactions">
        {ROOM_REACTIONS.map((r) => (
          <button
            type="button"
            key={r.key}
            className="room-chat__reaction"
            disabled={busy}
            onClick={() => send('reaction', `${r.emoji} ${r.label}`)}
          >
            <span aria-hidden="true">{r.emoji}</span> {r.label}
          </button>
        ))}
      </div>

      {/*
        * Поле ввода — второстепенное, и выглядит так намеренно: узкое,
        * без автофокуса, с коротким лимитом. Автофокус поднял бы
        * клавиатуру на пол-экрана у тех, кто просто раскрыл блок
        * посмотреть, что написали.
        */}
      <form
        className="room-chat__form"
        onSubmit={(e) => { e.preventDefault(); send('text', draft); }}
      >
        <input
          className="room-chat__input"
          value={draft}
          maxLength={200}
          placeholder="Пара слов"
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Сообщение в комнату"
        />
        <button type="submit" className="room-chat__send" disabled={busy || !draft.trim()} aria-label="Отправить">
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}

/** Подсказка в свёрнутой полосе — своя на каждый момент вечера. */
const PROMPT = {
  lobby: 'Сказать пару слов перед стартом',
  waiting: 'Пока ищем — можно перекинуться словом',
  match: 'Обсудить, смотрим ли',
};
