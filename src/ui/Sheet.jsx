import { useEffect, useRef } from 'react';
import { X } from './icons.js';

/**
 * Модальная шторка. Держит фокус внутри, закрывается по Escape и по клику
 * вне — три вещи, без которых модалка недоступна с клавиатуры.
 */
export function Sheet({ open, onClose, title, children, footer, variant = 'bottom', labelledBy }) {
  const panelRef = useRef(null);
  const restoreFocus = useRef(null);
  /* Началось ли нажатие именно на подложке, а не внутри шторки. */
  const pressedScrim = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocus.current = document.activeElement;

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector('button, input')?.focus();

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      restoreFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`scrim ${variant === 'center' ? 'scrim--center' : ''}`}
      /*
       * Закрываем, только если нажатие И отпускание пришлись на подложку.
       *
       * Раньше хватало одного `mousedown` — и на айфоне шторка
       * захлопывалась в тот момент, когда человек тапал по полю ввода.
       * Клавиатура поднимается и сдвигает вёрстку, а iOS досылает
       * синтетический mouse-событие по СТАРЫМ координатам: под ними
       * к тому моменту уже не поле, а подложка. Со стороны это
       * выглядит как «не успел напечатать — закрылось».
       *
       * Пара «нажал и отпустил на подложке» заодно чинит второй случай:
       * выделение текста мышью, увёденное за край шторки, больше её
       * не закрывает.
       */
      onPointerDown={(e) => { pressedScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (pressedScrim.current && e.target === e.currentTarget) onClose?.();
        pressedScrim.current = false;
      }}
    >
      <div
        className="sheet surface--hairline"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={labelledBy}
      >
        {variant === 'bottom' && <div className="sheet__grabber" />}
        {title && (
          <div className="row row--between" style={{ marginBottom: 'var(--s-4)' }}>
            <h2 className="section__title">{title}</h2>
            <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Закрыть">
              <X size={20} />
            </button>
          </div>
        )}
        {children}
        {footer && <div style={{ marginTop: 'var(--s-5)' }}>{footer}</div>}
      </div>
    </div>
  );
}
