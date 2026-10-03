import { previewFile } from './media-preview.js';
import { chooseUploadName } from './upload-name.js';
import { setupMotion } from './motion.js';
import { registerPwa } from './pwa.js';
import { t, formatBytes, setupPreferences, type MessageKey } from './preferences.js';
import type {
  ApiSuccess,
  ApiFailure,
  FilesPageDto,
  StorageCapabilitiesDto,
} from '../src/modules/files/presentation/http/file-dto.js';
let token = '',
  projectId = '',
  nextCursor: string | null = null,
  deletion = false,
  connected = false;
let busy = false;
let capabilities: StorageCapabilitiesDto | null = null;
let connectionState: MessageKey = 'disconnected';
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Не найден элемент ${id}`);
  return node as T;
}
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const value = (await response.json()) as ApiFailure;
    const code = value.error?.code;
    throw new Error(
      code === 'FILE_IN_USE'
        ? t('inUse')
        : response.status === 401 || response.status === 403
          ? t('forbidden')
          : (value.error?.message ?? t('error')),
    );
  }
  return response;
}
async function load(append = false) {
  const query = new URLSearchParams({ projectId, limit: '20' });
  if (append && nextCursor) query.set('cursor', nextCursor);
  const value = (await (
    await request(`/api/v1/files?${query}`)
  ).json()) as ApiSuccess<FilesPageDto>;
  if (!append) element('rows').replaceChildren();
  for (const file of value.data.items) {
    const row = document.createElement('tr');
    for (const text of [file.fileName ?? file.id, formatBytes(file.sizeBytes), file.mimeType]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (row.children.length === 1) cell.dataset.bytes = String(file.sizeBytes);
      row.append(cell);
    }
    const actions = document.createElement('td');
    const download = document.createElement('button');
    download.dataset.i18n = 'download';
    download.textContent = t('download');
    download.onclick = () =>
      run(async () => {
        const bytes = await (await request(`/api/v1/files/${file.id}/content`)).blob();
        const url = URL.createObjectURL(bytes),
          link = document.createElement('a');
        link.href = url;
        link.download = file.fileName ?? file.id;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    const preview = document.createElement('button');
    preview.dataset.i18n = 'preview';
    preview.textContent = t('preview');
    preview.onclick = () =>
      void previewFile(file, async (signal) =>
        (await request(`/api/v1/files/${file.id}/content`, { signal })).blob(),
      );
    actions.append(preview, download);
    if (deletion) {
      const remove = document.createElement('button');
      remove.dataset.i18n = 'remove';
      remove.textContent = t('remove');
      remove.className = 'danger';
      remove.onclick = () =>
        run(async () => {
          if (!window.confirm(t('removeConfirm', { name: file.fileName ?? file.id }))) return;
          await request(`/api/v1/files/${file.id}`, { method: 'DELETE' });
          await load();
          feedback('queued');
        });
      actions.append(remove);
    }
    row.append(actions);
    element('rows').append(row);
  }
  nextCursor = value.data.nextCursor;
  element('more').hidden = !nextCursor;
  const count = element('rows').children.length;
  element('file-count').textContent = String(count);
  element('file-count').setAttribute('aria-label', t('count', { count }));
  element('empty').hidden = count > 0;
  if (!count) element('empty').querySelector('p')!.textContent = t('emptyConnected');
}
function feedback(key: MessageKey) {
  element('feedback').dataset.i18n = key;
  element('feedback').textContent = t(key);
}
function updateLabels() {
  element('connection-state').textContent = t(connectionState);
  if (capabilities)
    element('configuration').textContent =
      `${t(capabilities.provider)} · ${t('limit', { size: formatBytes(capabilities.maxBytes) })}`;
  else element('configuration').textContent = t('configure');
  element('file-count').setAttribute(
    'aria-label',
    t('count', { count: element('rows').children.length }),
  );
  element('empty').querySelector('p')!.textContent = t(connected ? 'emptyConnected' : 'emptyIntro');
  const file = element<HTMLInputElement>('file').files?.[0];
  element('selected-file').textContent = file?.name ?? t('noFile');
  document.querySelectorAll<HTMLElement>('[data-bytes]').forEach((node) => {
    node.textContent = formatBytes(Number(node.dataset.bytes));
  });
}
function networkControls() {
  element('offline-notice').hidden = navigator.onLine;
  element<HTMLButtonElement>('connect').querySelector<HTMLButtonElement>('button')!.disabled =
    busy || !navigator.onLine;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '#upload button, #refresh, #more, #rows button',
  ))
    button.disabled = busy || !connected || !navigator.onLine;
  element<HTMLInputElement>('file').disabled = busy || !connected || !navigator.onLine;
}
async function run(action: () => Promise<void>) {
  busy = true;
  element('feedback').textContent = '';
  delete element('feedback').dataset.i18n;
  element('feedback').classList.remove('error');
  element('workspace').setAttribute('aria-busy', 'true');
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  for (const select of document.querySelectorAll<HTMLSelectElement>('.preferences select'))
    select.disabled = true;
  try {
    await action();
  } catch (error) {
    element('feedback').classList.add('error');
    element('feedback').textContent = error instanceof Error ? error.message : t('error');
  } finally {
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    for (const select of document.querySelectorAll<HTMLSelectElement>('.preferences select'))
      select.disabled = false;
    element('workspace').setAttribute('aria-busy', 'false');
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '#upload button, #refresh, #more',
    ))
      button.disabled = !connected;
    busy = false;
    networkControls();
  }
}
element('connect').onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    connected = false;
    capabilities = null;
    connectionState = 'connecting';
    element('connection-state').textContent = t(connectionState);
    element('connection-state').classList.remove('connected');
    element('rows').replaceChildren();
    element('file-count').textContent = '—';
    element('empty').hidden = false;
    element('more').hidden = true;
    element('configuration').textContent = t('checking');
    token = element<HTMLInputElement>('key').value;
    element<HTMLInputElement>('key').value = '';
    projectId = element<HTMLInputElement>('project').value;
    const value = (await (
      await request('/api/v1/storage')
    ).json()) as ApiSuccess<StorageCapabilitiesDto>;
    deletion = value.data.deleteEnabled;
    capabilities = value.data;
    await load();
    connected = true;
    connectionState = 'connected';
    updateLabels();
    element('connection-state').classList.add('connected');
  }).finally(() => {
    if (!connected) {
      capabilities = null;
      connectionState = 'disconnected';
      updateLabels();
      element('configuration').textContent = t('connectionFailed');
    }
  });
};
element('upload').onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    const file = element<HTMLInputElement>('file').files?.[0];
    if (!token || !file) throw new Error(t('selectFirst'));
    // Имена проверяются на всех страницах, а не только в видимых строках.
    const names = new Set<string>();
    let cursor: string | null = null;
    do {
      const pageQuery = new URLSearchParams({ projectId, limit: '100' });
      if (cursor) pageQuery.set('cursor', cursor);
      const page = (await (
        await request(`/api/v1/files?${pageQuery}`, { signal: AbortSignal.timeout(10000) })
      ).json()) as ApiSuccess<FilesPageDto>;
      page.data.items.forEach((item) => {
        if (item.fileName) names.add(item.fileName);
      });
      cursor = page.data.nextCursor;
    } while (cursor);
    const fileName = await chooseUploadName(file.name, names);
    if (!fileName) return;
    const query = new URLSearchParams({ projectId, fileName });
    await request(`/api/v1/files?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    feedback('saved');
    element<HTMLInputElement>('file').value = '';
    element('selected-file').textContent = t('noFile');
    await load();
  });
};
element('more').onclick = () => run(() => load(true));
element('refresh').onclick = () => run(() => load());

element<HTMLInputElement>('file').onchange = () => {
  element('selected-file').textContent =
    element<HTMLInputElement>('file').files?.[0]?.name ?? t('noFile');
};
setupPreferences(updateLabels);
updateLabels();

setupMotion();
void registerPwa();

window.addEventListener('online', networkControls);
window.addEventListener('offline', networkControls);
networkControls();
