export type Language = 'en' | 'ru' | 'es';
export type Theme = 'light' | 'dark' | 'system';
const en = {
  offlineNotice:
    'Offline: the interface is available, but connecting, uploading and downloading require the server.',
  tagline: 'Your files. Your storage.',
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  heroStart: 'A space for',
  heroEnd: 'your ',
  heroEmphasis: 'ideas.',
  description:
    'Photos, videos and whatever comes next. One interface for local files and Yandex Disk.',
  openStorage: 'Open storage',
  connectionSection: '01 / CONNECTION',
  workspace: 'Your workspace',
  privacy: 'Your key stays in this tab’s memory',
  key: 'Access key',
  keyPlaceholder: 'Enter your service key',
  project: 'Project ID',
  connect: 'Connect',
  configure: 'Connect to see your provider and available files.',
  librarySection: '02 / LIBRARY',
  files: 'Files',
  refresh: 'Refresh list',
  uploadTitle: 'Add something good',
  uploadHint: 'Choose a file to upload',
  chooseFile: 'Choose file',
  noFile: 'No file selected',
  upload: 'Upload',
  name: 'File name',
  size: 'Size',
  type: 'Type',
  actions: 'Actions',
  emptyTitle: 'Your library starts here',
  emptyIntro: 'Connect to a workspace to browse its files.',
  emptyConnected: 'No files yet. Choose your first file and upload it.',
  more: 'Load more',
  footer: 'Storage on your side.',
  download: 'Download',
  remove: 'Delete',
  removeConfirm: 'Delete file “{name}”?',
  queued: 'Deletion queued. The worker will remove the file from the provider.',
  saved: 'File saved by the server.',
  checking: 'Checking storage access…',
  connectionFailed: 'Connection failed. Check your key and project ID.',
  simulator: 'Local simulator — files in a Docker volume',
  yandex: 'Yandex Disk — cloud storage',
  limit: 'maximum {size} per file',
  selectFirst: 'Connect and choose a file first.',
  error: 'API request failed',
  count: 'Loaded files: {count}',
  language: 'Language',
  theme: 'Theme',
  light: 'Light',
  dark: 'Dark',
  system: 'System',
  byte: 'B',
  kb: 'KB',
  mb: 'MB',
  forbidden: 'Access denied. Check your key and permissions.',
  inUse: 'This file is in use and cannot be deleted.',
};
export type MessageKey = keyof typeof en;
const ru: Record<MessageKey, string> = {
  offlineNotice:
    'Нет сети: интерфейс доступен, но для подключения, загрузки и скачивания нужен сервер.',
  tagline: 'Ваши файлы. Ваше хранилище.',
  disconnected: 'Не подключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  heroStart: 'Место для',
  heroEnd: 'ваших ',
  heroEmphasis: 'идей.',
  description:
    'Фото, видео и всё, что будет дальше. Один интерфейс для локальных файлов и Яндекс Диска.',
  openStorage: 'Открыть хранилище',
  connectionSection: '01 / ПОДКЛЮЧЕНИЕ',
  workspace: 'Ваше пространство',
  privacy: 'Ключ хранится только в памяти вкладки',
  key: 'Ключ доступа',
  keyPlaceholder: 'Введите ключ сервиса',
  project: 'ID проекта',
  connect: 'Подключиться',
  configure: 'Подключитесь, чтобы увидеть провайдер и доступные файлы.',
  librarySection: '02 / БИБЛИОТЕКА',
  files: 'Файлы',
  refresh: 'Обновить список',
  uploadTitle: 'Добавьте что-нибудь хорошее',
  uploadHint: 'Выберите файл для загрузки',
  chooseFile: 'Выбрать файл',
  noFile: 'Файл не выбран',
  upload: 'Загрузить',
  name: 'Имя файла',
  size: 'Размер',
  type: 'Тип',
  actions: 'Действия',
  emptyTitle: 'Здесь начинается ваша библиотека',
  emptyIntro: 'Подключитесь к проекту, чтобы открыть его файлы.',
  emptyConnected: 'Пока нет файлов. Выберите первый файл и загрузите его.',
  more: 'Загрузить ещё',
  footer: 'Хранилище на вашей стороне.',
  download: 'Скачать',
  remove: 'Удалить',
  removeConfirm: 'Удалить файл «{name}»?',
  queued: 'Удаление принято в очередь; worker удалит файл у провайдера.',
  saved: 'Файл сохранён сервером.',
  checking: 'Проверяем доступ к хранилищу…',
  connectionFailed: 'Подключение не выполнено. Проверьте ключ и ID проекта.',
  simulator: 'Локальный симулятор — файлы в Docker volume',
  yandex: 'Яндекс Диск — облачное хранилище',
  limit: 'максимум {size} на файл',
  selectFirst: 'Подключитесь и выберите файл',
  error: 'Ошибка API',
  count: 'Загружено файлов: {count}',
  language: 'Язык',
  theme: 'Тема',
  light: 'Светлая',
  dark: 'Тёмная',
  system: 'Системная',
  byte: 'Б',
  kb: 'КБ',
  mb: 'МБ',
  forbidden: 'Доступ запрещён. Проверьте ключ и права.',
  inUse: 'Файл используется и не может быть удалён.',
};
const es: Record<MessageKey, string> = {
  offlineNotice:
    'Sin conexión: la interfaz está disponible, pero conectar, subir y descargar requiere el servidor.',
  tagline: 'Tus archivos. Tu almacenamiento.',
  disconnected: 'Sin conexión',
  connecting: 'Conectando…',
  connected: 'Conectado',
  heroStart: 'Un espacio para',
  heroEnd: 'tus ',
  heroEmphasis: 'ideas.',
  description:
    'Fotos, vídeos y todo lo que viene después. Una interfaz para archivos locales y Yandex Disk.',
  openStorage: 'Abrir almacenamiento',
  connectionSection: '01 / CONEXIÓN',
  workspace: 'Tu espacio',
  privacy: 'La clave queda en la memoria de esta pestaña',
  key: 'Clave de acceso',
  keyPlaceholder: 'Introduce la clave del servicio',
  project: 'ID del proyecto',
  connect: 'Conectar',
  configure: 'Conéctate para ver el proveedor y los archivos.',
  librarySection: '02 / BIBLIOTECA',
  files: 'Archivos',
  refresh: 'Actualizar lista',
  uploadTitle: 'Añade algo bueno',
  uploadHint: 'Elige un archivo para subir',
  chooseFile: 'Elegir archivo',
  noFile: 'Ningún archivo seleccionado',
  upload: 'Subir',
  name: 'Nombre',
  size: 'Tamaño',
  type: 'Tipo',
  actions: 'Acciones',
  emptyTitle: 'Tu biblioteca empieza aquí',
  emptyIntro: 'Conéctate a un espacio para ver sus archivos.',
  emptyConnected: 'Todavía no hay archivos. Elige el primero y súbelo.',
  more: 'Cargar más',
  footer: 'Almacenamiento de tu lado.',
  download: 'Descargar',
  remove: 'Eliminar',
  removeConfirm: '¿Eliminar el archivo «{name}»?',
  queued: 'Eliminación en cola. El worker eliminará el archivo del proveedor.',
  saved: 'Archivo guardado en el servidor.',
  checking: 'Comprobando el acceso…',
  connectionFailed: 'No se pudo conectar. Comprueba la clave y el ID del proyecto.',
  simulator: 'Simulador local — archivos en un volumen Docker',
  yandex: 'Yandex Disk — almacenamiento en la nube',
  limit: 'máximo {size} por archivo',
  selectFirst: 'Conéctate y elige un archivo primero.',
  error: 'Error de API',
  count: 'Archivos cargados: {count}',
  language: 'Idioma',
  theme: 'Tema',
  light: 'Claro',
  dark: 'Oscuro',
  system: 'Sistema',
  byte: 'B',
  kb: 'KB',
  mb: 'MB',
  forbidden: 'Acceso denegado. Comprueba la clave y los permisos.',
  inUse: 'El archivo está en uso y no se puede eliminar.',
};
const messages: Record<Language, Record<MessageKey, string>> = { en, ru, es };
function readPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Настройки остаются в памяти, если браузер запретил хранилище. */
  }
}
const savedLanguage = readPreference('files.language');
export let language: Language =
  savedLanguage === 'ru' || savedLanguage === 'es' ? savedLanguage : 'en';
const savedTheme = readPreference('files.theme');
let theme: Theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'system';
export function t(key: MessageKey, values: Record<string, string | number> = {}) {
  return messages[language][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    String(values[name] ?? match),
  );
}
export function formatBytes(bytes: number) {
  const locale = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} ${t('byte')}`;
  if (bytes < 1024 ** 2) return `${locale.format(bytes / 1024)} ${t('kb')}`;
  return `${locale.format(bytes / 1024 ** 2)} ${t('mb')}`;
}
function applyLanguage() {
  document.documentElement.lang = language;
  document.title = `Timepost Files — ${t('files')}`;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n as MessageKey);
  });
  const key = document.querySelector<HTMLInputElement>('#key');
  if (key) key.placeholder = t('keyPlaceholder');
  document.querySelector('#language')?.setAttribute('aria-label', t('language'));
  document.querySelector('#theme')?.setAttribute('aria-label', t('theme'));
  document.querySelector<HTMLSelectElement>('#language')!.value = language;
}
const darkMode = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const active = theme === 'system' ? (darkMode.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = active;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content =
    active === 'dark' ? '#20231e' : '#f4f3ed';
  document.querySelector<HTMLSelectElement>('#theme')!.value = theme;
}
export function setupPreferences(onLanguageChange: () => void) {
  applyLanguage();
  applyTheme();
  darkMode.addEventListener('change', applyTheme);
  document.querySelector<HTMLSelectElement>('#language')!.onchange = (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== 'en' && value !== 'ru' && value !== 'es') return;
    language = value;
    savePreference('files.language', language);
    applyLanguage();
    onLanguageChange();
  };
  document.querySelector<HTMLSelectElement>('#theme')!.onchange = (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    theme = value;
    savePreference('files.theme', theme);
    applyTheme();
  };
}
