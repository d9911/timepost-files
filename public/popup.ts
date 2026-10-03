import { t } from './preferences.js';

export function createPopup(title: string) {
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'file-popup';
  const heading = document.createElement('h2');
  heading.id = `popup-${crypto.randomUUID()}`;
  heading.textContent = title;
  dialog.setAttribute('aria-labelledby', heading.id);
  const header = document.createElement('header');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'popup-dismiss';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', t('closePopup'));
  header.append(heading, dismiss);
  const body = document.createElement('div');
  body.className = 'popup-body';
  dialog.append(header, body);
  const controller = new AbortController();
  let closing = false;
  const cleanups: Array<() => void> = [];
  function close() {
    if (closing) return;
    closing = true;
    controller.abort();
    cleanups.forEach((cleanup) => cleanup());
    dialog.classList.add('is-closing');
    setTimeout(
      () => {
        dialog.close();
        dialog.remove();
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      },
      matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
    );
  }
  dismiss.onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return {
    dialog,
    body,
    close,
    signal: controller.signal,
    onClose: (cleanup: () => void) => cleanups.push(cleanup),
  };
}
