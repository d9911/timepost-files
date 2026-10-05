import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadFile } from '../public/direct-upload.js';
import { previewType, suggestUniqueFileName } from '../public/media-helpers.js';

test('имена сохраняют расширение и обходят все известные совпадения', () => {
  assert.equal(
    suggestUniqueFileName('Photo.png', new Set(['photo.png', 'PHOTO (2).png'])),
    'Photo (3).png',
  );
  assert.equal(suggestUniqueFileName('.env', new Set(['.env'])), '.env (2)');
  assert.ok(suggestUniqueFileName('a'.repeat(250) + '.png', new Set()).length <= 255);
  assert.ok(suggestUniqueFileName('a.' + 'x'.repeat(253), new Set()).length <= 255);
});
test('предпросмотр разрешает медиа и не открывает HTML или SVG', async () => {
  assert.equal(previewType('application/octet-stream', 'voice.WAV'), 'audio/wav');
  assert.equal(previewType('video/mp4', 'clip.mp4'), 'video/mp4');
  assert.equal(previewType('application/octet-stream', 'animation.gif'), 'image/gif');
  assert.equal(previewType('text/html', 'photo.png'), null);
  assert.equal(previewType('image/svg+xml', 'icon.svg'), null);
  assert.equal(previewType('application/octet-stream', 'document.html'), null);
  const paths: string[] = [];
  const file = new File(['pdf'], 'document.pdf', { type: 'application/pdf' });
  await uploadFile(
    async (path, options) => {
      paths.push(path);
      if (path === '/api/v1/storage')
        return Response.json({
          success: true,
          data: {
            directUploads: true,
            genericFiles: true,
            maxFileBytes: 150000000,
            maxBytes: 10485760,
            maxVideoBytes: 104857600,
          },
        });
      assert.equal(options?.body, file);
      return Response.json({ success: true, data: { mediaFileId: 'legacy' } });
    },
    file,
    '3',
  );
  assert.ok(paths[1]?.startsWith('/api/v1/files?'));
});
