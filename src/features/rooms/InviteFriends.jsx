import { useEffect, useState } from 'react';
import { Check, Loader2, UserPlus } from '../../ui/icons.js';
import { loadFriends } from '../../engine/social.js';
import { inviteFriendToRoom } from '../../engine/rooms.js';
import { haptic } from '../../lib/telegram.js';

/**
 * Позвать в комнату тех, кто уже в приложении.
 *
 * Отдельно от ссылки-приглашения, и это разные задачи. Ссылку кидают
 * кому угодно, включая тех, у кого MatchWatch ещё нет; здесь зовут
 * конкретного друга, которому не надо ни ставить приложение, ни вводить
 * код — уведомление приходит с кнопкой прямо в комнату.
 *
 * Показывается только когда друзья есть. Пустой список «позовите
 * друзей» у человека без друзей — упрёк, а не подсказка: у него их нет
 * и добавить отсюда некого.
 */
export function InviteFriends({ code, members = [], toasts }) {
  const [friends, setFriends] = useState([]);
  const [busy, setBusy] = useState(null);
  const [invited, setInvited] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    loadFriends()
      .then((list) => {
        if (!alive) return;
        setFriends(list.filter((f) => f.status === 'accepted'));
      })
      .catch(() => { /* приглашение — не условие работы комнаты */ });
    return () => { alive = false; };
  }, []);

  /* Тех, кто уже внутри, звать незачем — они и так здесь. */
  const inside = new Set(members.map((m) => m.uid));
  const list = friends.filter((f) => !inside.has(f.id));

  if (list.length === 0) return null;

  const invite = async (person) => {
    setBusy(person.id);
    haptic('light');
    try {
      await inviteFriendToRoom(code, person.id);
      setInvited((prev) => new Set(prev).add(person.id));
      toasts?.success?.(`Позвали ${person.displayName}`);
    } catch (error) {
      toasts?.error?.(error?.message ?? 'Не получилось позвать');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="section">
      <h2 className="section__title">Позвать друзей</h2>
      <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
        Придёт уведомление с кнопкой — код вводить не придётся.
      </p>

      <div className="stack gap-2">
        {list.map((person) => (
          <div className="member" key={person.id}>
            {person.photoURL
              ? <img className="member__avatar" src={person.photoURL} alt="" />
              : <span className="member__avatar member__avatar--empty">
                  {(person.displayName ?? '?')[0]?.toUpperCase()}
                </span>}
            <span className="stack grow" style={{ minWidth: 0 }}>
              <span className="member__name truncate">{person.displayName}</span>
              <span className="member__state truncate">@{person.username}</span>
            </span>

            {invited.has(person.id) ? (
              <span className="chip chip--ice"><Check size={12} /> позвали</span>
            ) : (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy === person.id}
                onClick={() => invite(person)}
              >
                {busy === person.id
                  ? <Loader2 size={16} className="spin" />
                  : <><UserPlus size={16} /> Позвать</>}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
