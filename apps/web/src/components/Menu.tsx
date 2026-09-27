import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './Menu.css';

const CloseContext = createContext<() => void>(() => undefined);

/**
 * A button that opens a short list of actions below it — the ⋯ on a post, say. Closes on picking
 * an item, clicking anywhere else, or Escape.
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  role,
  align = 'start',
  children,
}: {
  /** Accessible name for the trigger, also its tooltip. */
  label: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  triggerClassName: string;
  role?: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (evt: PointerEvent) => {
      if (!rootRef.current?.contains(evt.target as Node)) setOpen(false);
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="nu-menu" ref={rootRef}>
      <button
        type="button"
        className={triggerClassName}
        data-nu-role={role}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <CloseContext.Provider value={() => setOpen(false)}>
          <div className={`nu-menu__list nu-menu__list--${align}`} role="menu" data-nu-role={role && `${role}-list`}>
            {children}
          </div>
        </CloseContext.Provider>
      )}
    </span>
  );
}

export function MenuItem({
  icon,
  danger,
  role,
  onSelect,
  children,
}: {
  icon?: IconName;
  danger?: boolean;
  role?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  const close = useContext(CloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'nu-menu__item nu-menu__item--danger' : 'nu-menu__item'}
      data-nu-role={role}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      {icon && <Icon name={icon} size={15} />}
      {children}
    </button>
  );
}
