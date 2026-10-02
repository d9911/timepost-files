let token = '',
  projectId = '',
  nextCursor = null,
  deletion = false;
const element = (id) => document.getElementById(id);
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const value = await response.json();
    throw new Error(value.error?.message ?? 'Ошибка API');
  }
  return response;
}
async function load(append = false) {
  const query = new URLSearchParams({ projectId, limit: '20' });
  if (append && nextCursor) query.set('cursor', nextCursor);
  const value = await (await request(`/api/v1/files?${query}`)).json();
  if (!append) element('rows').replaceChildren();
  for (const file of value.data.items) {
    const row = document.createElement('tr');
    for (const text of [file.fileName ?? file.id, `${file.sizeBytes} байт`, file.mimeType]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    const actions = document.createElement('td');
    const download = document.createElement('button');
    download.textContent = 'Скачать';
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
    actions.append(download);
    if (deletion) {
      const remove = document.createElement('button');
      remove.textContent = 'Удалить';
      remove.onclick = () =>
        run(async () => {
          if (!window.confirm(`Удалить файл «${file.fileName ?? file.id}»?`)) return;
          await request(`/api/v1/files/${file.id}`, { method: 'DELETE' });
          await load();
          element('feedback').textContent =
            'Удаление принято в очередь; worker удалит файл у провайдера.';
        });
      actions.append(remove);
    }
    row.append(actions);
    element('rows').append(row);
  }
  nextCursor = value.data.nextCursor;
  element('more').hidden = !nextCursor;
}
async function run(action) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    await action();
  } catch (error) {
    element('feedback').textContent = error.message;
  } finally {
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}
element('connect').onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    token = element('key').value;
    element('key').value = '';
    projectId = element('project').value;
    const value = await (await request('/api/v1/storage')).json();
    deletion = value.data.deleteEnabled;
    element('configuration').textContent =
      `${value.data.provider === 'simulator' ? 'Локальный симулятор — файлы в Docker volume' : 'Яндекс Диск — облачное хранилище'} · максимум ${value.data.maxBytes} байт`;
    await load();
  });
};
element('upload').onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    const file = element('file').files[0];
    if (!token || !file) throw new Error('Подключитесь и выберите файл');
    const query = new URLSearchParams({ projectId, fileName: file.name });
    await request(`/api/v1/files?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    element('feedback').textContent = 'Файл сохранён сервером.';
    element('file').value = '';
    await load();
  });
};
element('more').onclick = () => run(() => load(true));
element('refresh').onclick = () => run(() => load());
