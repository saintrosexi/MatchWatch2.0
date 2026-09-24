import { useEffect, useRef, useState } from 'react';
import { AtSign, Check, Image as ImageIcon, Loader2, UserRound, Trash2 } from '../../ui/icons.js';
import { Sheet } from '../../ui/Sheet.jsx';
import {
  AVATAR_MIME, isUsernameAvailable, saveProfile, suggestUsername, uploadAvatar,
} from '../../engine/social.js';
import { getTelegramUser } from '../../lib/telegram.js';

const BIO_LIMIT = 280;

/**
 * Редактор профиля.
 *
 * Ник проверяется на занятость по мере ввода, но окончательный арбитр —
 * уникальный индекс в базе: между проверкой и отправкой проходят
 * секунды, и за это время ник может занять кто-то другой.
 */
export function ProfileEditor({ open, onClose, uid, profile, onSaved, toasts }) {
  const telegram = getTelegramUser();

  const [form, setForm] = useState({ displayName: '', username: '', bio: '', photoURL: '' });
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [availability, setAvailability] = useState(null); // null | 'checking' | 'free' | 'taken'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      displayName: profile?.display_name ?? profile?.displayName ?? '',
      /*
       * Ник подставляем из Telegram: он уже уникален и человек его знает.
       * Производное от имени — запасной вариант для входа по email.
       */
      username: profile?.username
        ?? suggestUsername(telegram?.username ?? profile?.display_name ?? ''),
      bio: profile?.bio ?? '',
      photoURL: profile?.photo_url ?? profile?.photoURL ?? '',
    });
    setError(null);
    setAvailability(null);
  }, [open, profile]);

  const currentUsername = (profile?.username ?? '').toLowerCase();

  useEffect(() => {
    const value = form.username.trim().toLowerCase();
    if (!open || !value || value === currentUsername) { setAvailability(null); return undefined; }

    setAvailability('checking');
    const timer = setTimeout(() => {
      isUsernameAvailable(value)
        .then((free) => setAvailability(free ? 'free' : 'taken'))
        .catch(() => setAvailability(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [form.username, open, currentUsername]);

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    // Значение поля сбрасываем сразу: иначе повторный выбор того же
    // файла не вызовет change и кнопка будет выглядеть сломанной.
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const url = await uploadAvatar(uid, file);
      if (url) setForm((f) => ({ ...f, photoURL: url }));
    } catch (err) {
      setError(err?.message ?? 'Не удалось загрузить фото');
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProfile(uid, form);
      onSaved?.(saved);
      toasts.success('Профиль обновлён');
      onClose();
    } catch (err) {
      setError(err?.message ?? 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const usernameHint = {
    checking: 'проверяем…',
    free: 'ник свободен',
    taken: 'ник уже занят',
  }[availability];

  return (
    <Sheet open={open} onClose={onClose} title="Профиль">
      <form className="stack gap-5" onSubmit={submit}>
        <div className="row gap-4">
          {form.photoURL
            ? <img className="editor__avatar" src={form.photoURL} alt="" />
            : <span className="editor__avatar editor__avatar--empty"><UserRound size={26} /></span>}

          <div className="stack gap-2 grow" style={{ minWidth: 0 }}>
            <span className="field__label">Фото</span>

            {/*
              * Ссылку на картинку человек ввести не может — у него есть
              * фотография, а не URL. Заодно уходит битая картинка в чужом
              * профиле: сторонние ссылки протухают, и отвечать за них некому.
              */}
            <input
              ref={fileRef}
              type="file"
              accept={AVATAR_MIME.join(',')}
              hidden
              onChange={pickPhoto}
            />

            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading
                  ? <><Loader2 size={16} className="spin" /> Загружаем…</>
                  : <><ImageIcon size={16} /> {form.photoURL ? 'Заменить' : 'Загрузить'}</>}
              </button>

              {telegram?.photo_url && form.photoURL !== telegram.photo_url && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={uploading}
                  onClick={() => setForm((f) => ({ ...f, photoURL: telegram.photo_url }))}
                >
                  Из Telegram
                </button>
              )}

              {form.photoURL && (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  disabled={uploading}
                  onClick={() => setForm((f) => ({ ...f, photoURL: '' }))}
                  aria-label="Убрать фото"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>

            <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
              JPEG, PNG, WebP или GIF, до 2 МБ.
            </span>
          </div>
        </div>

        <label className="field">
          <span className="field__label">Имя</span>
          <input
            className="input"
            type="text"
            maxLength={60}
            placeholder="Как вас зовут"
            value={form.displayName}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          />
          <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
            Показывается в комнатах и в профиле. Может повторяться — это не адрес.
          </span>
        </label>

        <label className="field">
          <span className="field__label">Ник</span>
          <div className="row gap-2 surface" style={{ padding: '0 var(--s-3)', borderRadius: 'var(--r)' }}>
            <AtSign size={16} color="var(--text-low)" />
            <input
              className="input"
              style={{ background: 'none', border: 'none' }}
              type="text"
              maxLength={24}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="nickname"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.replace(/[^a-zA-Z0-9._]/g, '') }))}
            />
            {availability === 'checking' && <Loader2 size={16} color="var(--text-low)" />}
            {availability === 'free' && <Check size={16} color="var(--success)" />}
          </div>
          <span
            className="faint"
            style={{ fontSize: 'var(--t-micro)', color: availability === 'taken' ? 'var(--coral)' : undefined }}
          >
            {usernameHint ?? 'По нику вас найдут друзья. 3–24 символа: латиница, цифры, точка, подчёркивание.'}
          </span>
        </label>

        <label className="field">
          <span className="field__label">О себе</span>
          <textarea
            className="input"
            style={{ minHeight: 88, padding: 'var(--s-3)', resize: 'vertical', lineHeight: 1.5 }}
            maxLength={BIO_LIMIT}
            placeholder="Что смотрите и что советуете"
            value={form.bio}
            onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
          />
          <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
            {form.bio.length} из {BIO_LIMIT}
          </span>
        </label>

        {error && <p className="auth__error">{error}</p>}

        <button
          type="submit"
          className="btn btn--primary btn--lg btn--block"
          disabled={saving || availability === 'taken'}
        >
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </form>
    </Sheet>
  );
}
