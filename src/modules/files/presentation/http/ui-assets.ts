import { iconSizes } from '../../../../shared/domain/branding.js';
const assets = new Map<string, { name: string; contentType: string }>();
function asset(path: string, contentType: string, name = path.slice(1)) {
  assets.set(path, { name, contentType });
}
asset('/', 'text/html; charset=utf-8', 'index.html');
for (const name of ['app.js', 'preferences.js', 'pwa.js', 'sw.js'])
  asset(`/${name}`, 'text/javascript; charset=utf-8');
asset('/style.css', 'text/css; charset=utf-8');
asset('/favicon.ico', 'image/x-icon');
asset('/manifest.webmanifest', 'application/manifest+json');
asset('/icons/favicon.svg', 'image/svg+xml');
for (const name of ['apple-touch-icon', 'maskable-512x512', 'social-preview'])
  asset(`/icons/${name}.png`, 'image/png');
for (const size of iconSizes) asset(`/icons/icon-${size}x${size}.png`, 'image/png');
// Поиск только по точному пути: приватные файлы и произвольные пути не публикуются.
export function publicUiAsset(path: string) {
  return assets.get(path);
}
