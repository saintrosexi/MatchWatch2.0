import { useState } from 'react';
import { AtSign, KeyRound, Loader2, Send, UserRound } from '../../ui/icons.js';
import { isTelegram } from '../../lib/telegram.js';
import { BrandLockup } from '../../ui/Brand.jsx';

/**
 * Экран входа. Ровно два способа, как и задумано:
 * Telegram внутри Mini App и email в обычном вебе.
 *
 * Внутри Telegram email-форма не прячется совсем, но уходит под спойлер:
 * основной сценарий там — один тап.
 */
export function AuthScreen({ auth }) {
  const [mode, setMode] = useState(isTelegram() ? 'telegram' : 'email');
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const inTelegram = isTelegram();

  const submitEmail = async (e) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await auth.signInWithEmail(form.email.trim(), form.password, {
        register, displayName: form.displayName.trim() || undefined,
      });
    } catch {
      // Текст ошибки уже в auth.error.
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!form.email.trim()) { setNotice('Введите email — вышлем ссылку для сброса.'); return; }
    try {
      await auth.resetPassword(form.email.trim());
      setNotice('Письмо отправлено. Проверьте почту.');
    } catch {
      setNotice('Не удалось отправить письмо. Проверьте адрес.');
    }
  };

  return (
    <div className="auth">
      <div className="stack gap-4">
        <BrandLockup size="xl" stacked />
        <p className="auth__lede">
          Свайпайте фильмы вдвоём. Совпали — значит, вечер спасён.
        </p>
      </div>

      {auth.error && (
        <div className="auth__error" role="alert">
          {auth.error.text}
        </div>
      )}

      <div className="auth__methods">
        {inTelegram && (
          <button
            type="button"
            className="btn btn--primary btn--lg btn--block"
            onClick={() => auth.signInWithTelegram()}
            disabled={busy || auth.status === 'signing-in'}
          >
            {auth.status === 'signing-in'
              ? <><Loader2 size={20} className="spin" /> Входим…</>
              : <><Send size={20} /> Продолжить в Telegram</>}
          </button>
        )}

        {inTelegram && mode !== 'email' && (
          <button type="button" className="btn btn--quiet" onClick={() => setMode('email')}>
            Войти по email
          </button>
        )}

        {(!inTelegram || mode === 'email') && (
          <>
            {inTelegram && <div className="auth__divider">или по email</div>}

            <form className="stack gap-3" onSubmit={submitEmail}>
              {register && (
                <label className="field">
                  <span className="field__label">Как вас зовут</span>
                  <div className="row gap-2 surface" style={{ padding: '0 var(--s-3)', borderRadius: 'var(--r)' }}>
                    <UserRound size={16} color="var(--text-low)" />
                    <input
                      className="input"
                      style={{ background: 'none', border: 'none' }}
                      type="text"
                      autoComplete="nickname"
                      maxLength={40}
                      value={form.displayName}
                      onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                      placeholder="Аня"
                    />
                  </div>
                </label>
              )}

              <label className="field">
                <span className="field__label">Email</span>
                <div className="row gap-2 surface" style={{ padding: '0 var(--s-3)', borderRadius: 'var(--r)' }}>
                  <AtSign size={16} color="var(--text-low)" />
                  <input
                    className="input"
                    style={{ background: 'none', border: 'none' }}
                    type="email"
                    autoComplete="email"
                    required
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="you@mail.ru"
                  />
                </div>
              </label>

              <label className="field">
                <span className="field__label">Пароль</span>
                <div className="row gap-2 surface" style={{ padding: '0 var(--s-3)', borderRadius: 'var(--r)' }}>
                  <KeyRound size={16} color="var(--text-low)" />
                  <input
                    className="input"
                    style={{ background: 'none', border: 'none' }}
                    type="password"
                    autoComplete={register ? 'new-password' : 'current-password'}
                    required
                    minLength={6}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="Минимум 6 символов"
                  />
                </div>
              </label>

              <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
                {busy ? 'Секунду…' : register ? 'Создать аккаунт' : 'Войти'}
              </button>

              <div className="row row--between">
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setRegister((v) => !v)}>
                  {register ? 'У меня есть аккаунт' : 'Зарегистрироваться'}
                </button>
                {!register && (
                  <button type="button" className="btn btn--quiet btn--sm" onClick={reset}>
                    Забыли пароль?
                  </button>
                )}
              </div>

              {register && (
                <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                  Подтверждать почту не нужно — входите сразу после регистрации.
                  Email нужен только как логин.
                </p>
              )}

              {notice && <p className="faint" style={{ fontSize: 'var(--t-small)' }}>{notice}</p>}
            </form>
          </>
        )}
      </div>

      <p className="auth__legal">
        Входя, вы соглашаетесь с тем, что мы храним историю ваших свайпов,
        чтобы подбирать кино точнее. Данные о фильмах — TMDB.
      </p>
    </div>
  );
}
