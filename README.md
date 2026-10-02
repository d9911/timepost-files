# Timepost Files

[English](README.md) · [Русский](README.ru.md) · [Español](README.es.md)

A private REST file-storage service built with Node.js 24 and TypeScript. It runs an API, PostgreSQL and a deletion worker. File bytes are stored on Yandex Disk or through an explicitly selected local filesystem provider (`simulator`). The management UI uses plain TypeScript.

## Standalone quick start

Run `make start` from this directory. It installs build dependencies, compiles the service, creates `.env` with random service keys and a database password, builds Docker containers and waits for readiness. Existing configuration and volumes are preserved. Standalone use requires this directory, Docker Compose and Node.js 24; neighboring Timepost repositories are optional.

From the Timepost workspace root, use `make files-standalone`. The fallback entry point is `make -f scripts/main/Makefile files-standalone`.

Open <http://127.0.0.1:3060>, enter `FILES_API_KEY` from your local `.env` and choose a numeric workspace ID. The UI supports listing with load-more pagination, uploading, downloading and queuing deletion. The key stays in page memory. `FILES_READONLY_API_KEY` grants read-only access.

Standalone keys apply to the whole instance, including all workspaces; they are service credentials rather than per-user permissions. The HTTP port binds to loopback. Cloud OAuth credentials stay on the server. Keep `.env` private.

| Command                         | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `make start`                    | Build and start API, PostgreSQL and worker            |
| `make ps` / `make logs`         | Inspect containers and API/worker logs                |
| `make stop`                     | Stop containers while preserving data                 |
| `make config`                   | Validate Compose without printing secrets             |
| `make smoke`                    | Test the simulator and remove only its own test files |
| `make test-db`                  | Exercise PostgreSQL insert/get/list with rollback     |
| `make build` / `make typecheck` | Compile / check strict TypeScript                     |
| `make test` / `make lint`       | Run tests / ESLint and formatting checks              |
| `make docs`                     | Generate standalone HTML API documentation            |

The workspace equivalent of `make smoke` is `make files-smoke`.

## Yandex Disk configuration

Set `STORAGE_PROVIDER=yandex` and `YANDEX_DISK_OAUTH_TOKEN` in `files/.env`, then run `make start` again. The token needs access to the application folder `app:/timepost`; see the [official REST API and OAuth documentation](https://yandex.ru/dev/disk/rest/).

Metadata remains in PostgreSQL; bytes are uploaded to Disk. Cloud errors do not trigger a fallback to local storage. Records belonging to another provider are hidden from listings; metadata/content requests for them return a provider-mismatch error. Personal Disk connections for individual users and Google Drive support are not implemented. Real cloud execution requires a valid token and has not been verified.

## API and lifecycle

The contract is available as [openapi.json](openapi.json) and [openapi.yaml](openapi.yaml). Run `npm run openapi:generate` to regenerate it or `npm run openapi:check` to check it. There is no exposed HTTP Swagger endpoint. This is the service's own REST API, rather than a GraphQL schema or an exact copy of the Yandex Disk HTTP API.

| Request                                              | Behavior                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `POST /api/v1/files?projectId=1&fileName=photo.png`  | Upload raw bytes with Bearer authentication                 |
| `GET /api/v1/files?projectId=1&limit=20&cursor=UUID` | List ready files with cursor pagination                     |
| `GET /api/v1/files/{id}`                             | Read metadata                                               |
| `GET /api/v1/files/{id}/content`                     | Download private content                                    |
| `DELETE /api/v1/files/{id}`                          | Return HTTP 202 and queue durable deletion                  |
| `GET /api/v1/files/{id}/deletion`                    | Read deletion status and attempts, including after deletion |
| `GET /api/v1/storage`                                | Read sanitized storage capabilities                         |
| `GET /health/ready`                                  | Check readiness                                             |

Images and generic files are limited to 10 MiB (`10 × 1024 × 1024` bytes); videos to 100 MiB (`100 × 1024 × 1024` bytes). JPEG/PNG/WebP must decode successfully, contain one frame and fit within 4096 × 4096 pixels. ffprobe validates MP4 H.264/AAC and WebM VP8/VP9 with Opus/Vorbis: one video stream, at most one audio stream, up to 4096 × 4096 pixels and 60 minutes. Metadata includes `durationSeconds`.

HEIC, AVI, MOV, transcoding, poster extraction and full video decoding are not implemented. Authenticated video downloads use a Blob and the existing player; HTTP Range and resumable uploads are not supported. Standalone generic files are stored as `application/octet-stream` and downloaded as attachments. Antivirus scanning is not implemented.

Downloads verify size and SHA-256. Uploads become `ready` after provider confirmation. The worker queues cleanup for unfinished `pending` uploads older than 24 hours.

File deletion transitions through `deleting` → `deleted`; jobs use `pending` → `running` → `done`, retry or `failed`. PostgreSQL provides the durable queue and a 120-second lease. A job stops after 10 processed failures; repeating DELETE restarts a stopped job. Deleted metadata is retained for audit. This queue does not require Redis, Kafka or RabbitMQ. API migrations run serially under a database lock. Configure volume/cloud backups separately.

## Timepost integration

Workspace `make start`, `make dev` (an alias for `dev-local`), `make dev-docker` and `make dev-local` include Files. `make files-start` starts Files and its dependencies. The main stack defaults to the simulator with Accounts sessions and Projects access checks. For cloud storage, set `FILES_STORAGE_PROVIDER=yandex` and `YANDEX_DISK_OAUTH_TOKEN` in the root `.env`.

The frontend uses `/api/files-service`. Posts validates `mediaFileId` through Files. Direct file deletion in Timepost is blocked until publication references are accounted for. Standalone service keys do not replace Timepost user permissions.

`make dev` already prepares seed data. `make seed` adds missing demo records in Accounts/Projects/Posts/Notifications and the Analytics catalog; it does not reset an existing database. Files creates bytes through successful uploads, rather than fabricated seed files. Restarting or seeding does not clear its volumes.

Editor data flow: browser → `/api/files-service/api/v1/files` → Files → storage provider. The browser then submits `mediaFileId` to Posts. Posts checks metadata using the user session and stores the image/video type, dimensions and reference. Reopening the editor returns the saved ID without requiring another upload. Reels and Stories use the same storage flow; this does not confirm delivery to a social network.

Avatar and cover images can technically be stored as project images. Persisting their references requires the owning Accounts/Projects contract. Automatic integration of all avatars, covers and chat attachments is not implemented.

## Standalone API examples

Export the service key locally from your `.env`; do not embed it in documentation. Timepost uses a user Bearer token instead.

```sh
# Upload an image; the response contains data.mediaFileId.
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  -H 'Content-Type: image/jpeg' --data-binary @photo.jpg \
  'http://127.0.0.1:3060/api/v1/files?projectId=1&fileName=photo.jpg'

# For MP4 uploads, use video/mp4 and the corresponding file path.
# List files.
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  'http://127.0.0.1:3060/api/v1/files?projectId=1&limit=20'

# Set FILE_ID to the UUID returned by the upload.
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  "http://127.0.0.1:3060/api/v1/files/$FILE_ID/content" --output saved-file
curl --fail-with-body -X DELETE -H "Authorization: Bearer $FILES_API_KEY" \
  "http://127.0.0.1:3060/api/v1/files/$FILE_ID"
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  "http://127.0.0.1:3060/api/v1/files/$FILE_ID/deletion"
```

## Relationship to Yandex Disk

Both providers implement the same internal `ready/upload/download/delete` interface and preserve the external Files contract.

| Files operation | Yandex Disk adapter                         | Local simulator              |
| --------------- | ------------------------------------------- | ---------------------------- |
| Preparation     | `PUT /resources` for `app:/timepost`        | Create storage directory     |
| Upload          | `/resources/upload`, followed by binary PUT | Write and sync a UUID file   |
| Content         | `/resources/download`, followed by GET      | Read a UUID file             |
| Delete          | `DELETE /resources` with `permanently=true` | Unlink a UUID file           |
| List/metadata   | This service's PostgreSQL metadata          | The same PostgreSQL metadata |

OAuth is sent only to the Disk API. Temporary transfer URLs stay on the server; HTTPS and domains are checked, and redirects are rejected. A provider HTTP 202 does not mean a completed upload; unfinished operations remain pending. See the [adapter implementation](src/modules/files/infrastructure/storage/yandex-disk-storage.ts), [Yandex REST API](https://yandex.ru/dev/disk/rest/), [Disk API introduction](https://yandex.ru/dev/disk-api/doc/ru/) and [OAuth application registration](https://www.yandex.ru/dev/id/doc/ru/register-client). The adapter still needs a real-token cloud test.

## Hosting on your own server

The explicit `simulator` provider stores real bytes in the persistent `objects` volume and metadata in `metadata`. It can run on your server. Configure backups for both volumes, an HTTPS reverse proxy and separate service keys. Keep PostgreSQL private; Compose binds HTTP to loopback by default. User registration belongs to Accounts in Timepost; standalone mode uses service keys.

Switching `simulator` ↔ `yandex` changes the provider for new uploads without migrating existing bytes. Provider-mismatched records are unavailable. Migration would require copying bytes, verifying checksums and updating metadata; that procedure is not implemented.

Without Docker, install PostgreSQL, Node.js 24 and ffprobe on PATH. Run `npm ci`, export settings from `.env.example`, then `npm run build` and `npm start`. Start a separate worker with `FILES_ROLE=worker npm start`. Node does not automatically load `.env`.

## TypeScript, architecture and documentation

The API, worker, adapters, scripts, tests and UI source use TypeScript with `strict` and `noUncheckedIndexedAccess`. Build errors prevent emission. `npm run build` cleans generated `dist/`, compiles the code and copies UI assets/test fixtures. `npm start` runs `dist/src/server.js`. The multi-stage Docker build produces a runtime with production dependencies, migrations, ffmpeg and compiled API/worker/UI.

```text
src/
  app/                         dependency composition and API/worker bootstrap
  modules/
    files/
      domain/                  file model, statuses and limits
      application/             file operations and deletion processing
        ports/                 repository, storage, media and identity contracts
      infrastructure/          PostgreSQL, Yandex Disk, filesystem, sharp/ffprobe
      presentation/            HTTP handlers, DTOs and OpenAPI
      contracts.ts             public module types
    access/
      application/             authorization and project-access contract
      infrastructure/          Accounts/Projects JWT and standalone API keys
      contracts.ts             public access types
  shared/                      errors, guards and infrastructure contracts
  server.ts                    stable entry point
```

`FileService` receives interfaces through constructor injection. Application errors have typed codes; the HTTP layer maps them to statuses. Media validation and UUID/checksum generation are adapters. Application byte contracts use `Uint8Array` and `AsyncIterable`, independently of sharp, PostgreSQL and HTTP `Response`. Dependencies are wired in `app/create-file-service.ts` and `app/bootstrap.ts`.

Domain types live in `modules/files/domain/file.ts`, ports in `application/ports`, and HTTP DTOs in `presentation/http/file-dto.ts`. The UI reuses DTOs through `import type`. Public types are exported through the files/access `contracts.ts` files. The architecture test checks dependency direction and access through module contracts.

Run `npm run typecheck`, `npm test`, `npm run lint` and `npm run format:check` for verification. `make test-db` rolls back its database changes. `make smoke` creates PNG, MP4 and generic files, verifies reads and deletes its own files.

`npm run openapi:docs` / `make docs` generates `documentation/index.html` using the local Redocly development dependency. Generated `dist/` and `documentation/` are excluded from Git.

In the full workspace, `make api-sync` updates contracts and consumer snapshots; `make api-check` checks code consistency and lints OpenAPI. `make api-docs` is a separate manual HTML/JSON/YAML/ZIP export to `archive/docs/`; `archive/docs/api/index.html` provides service navigation. These exports are not required at runtime and are not rebuilt by dev, seed or api-sync. Shared Redocly tooling lives in Scripts, not in the frontend. `public/index.html` is the management UI; `archive/docs/api/files.html` is an API reference. Workspace generators: [contracts](../scripts/openapi-contracts.mjs), [HTML/ZIP](../scripts/openapi-handoff.mjs).

Workspace `make files-integration-smoke` checks Accounts/Projects → Files → Posts Reels draft → reopen/update → private content. It needs seeded credentials/project from local `.env.seed`, removes its own post and leaves a small file because direct Timepost deletion is blocked. It does not publish to social networks.

Optional workspace verification reports: [standalone service](../archive/docs/reports/2026-10-02-files-standalone.md), [media integration](../archive/docs/reports/2026-10-02-files-media-integration.md), [architecture refactor](../archive/docs/reports/2026-10-02-files-clean-architecture.md).
