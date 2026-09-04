// Lightweight promise-based confirm dialog (danger/sensitive operations gate).
import { h } from './dom';
import { t } from '../i18n';

export interface ConfirmOptions {
  title: string;
  body: string;
  okText?: string;
  danger?: boolean;
  detail?: string;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const okText = opts.okText ?? t('confirm.ok');
    const backdrop = h(
      'div',
      { class: 'backdrop' },
      h(
        'div',
        { class: 'dialog' },
        h('h3', {}, opts.title),
        h('p', {}, opts.body),
        opts.detail ? h('p', { class: 'notice' }, opts.detail) : null,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'ghost' }, t('confirm.cancel')),
          h('button', { class: opts.danger ? 'danger' : 'primary' }, okText),
        ),
      ),
    );
    const [cancelBtn, okBtn] = [...backdrop.querySelectorAll('button')] as HTMLButtonElement[];
    const done = (v: boolean) => {
      backdrop.remove();
      resolve(v);
    };
    cancelBtn.addEventListener('click', () => done(false));
    okBtn.addEventListener('click', () => done(true));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done(false);
    });
    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}
