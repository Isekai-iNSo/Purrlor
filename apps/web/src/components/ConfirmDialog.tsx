import { useCallback, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

export type ConfirmOptions = {
  title: string;
  /** What will happen, in plain words — shown above the buttons. */
  message: ReactNode;
  /** The confirm button's label, naming the action ("Delete", "Remove"). */
  confirmLabel: string;
  /** Red confirm button, for anything that can't be taken back. Defaults to true. */
  danger?: boolean;
};

/**
 * A "are you sure?" step in front of an action that's easy to hit by mistake and hard to undo.
 * `confirm(options)` resolves true if the person confirms and false if they cancel or dismiss;
 * render `dialog` anywhere in the component.
 */
export function useConfirm(): { confirm: (options: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void }>();

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })),
    []
  );

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(undefined);
  };

  const dialog = pending ? (
    <Modal title={pending.options.title} onClose={() => settle(false)}>
      <div className="nu-modal-form" data-nu-role="confirm-dialog">
        <p>{pending.options.message}</p>
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" data-nu-role="confirm-cancel" onClick={() => settle(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={pending.options.danger === false ? 'nu-button nu-button--primary' : 'nu-button nu-button--danger'}
            data-nu-role="confirm-ok"
            autoFocus
            onClick={() => settle(true)}
          >
            {pending.options.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  ) : null;

  return { confirm, dialog };
}
