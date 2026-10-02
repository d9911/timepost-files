# Timepost Files

[English](README.md) · [Русский](README.ru.md) · [Español](README.es.md)

Servicio privado de almacenamiento de archivos con API REST, Node.js 24 y TypeScript. Ejecuta una API, PostgreSQL y un worker de eliminación. Los bytes se guardan en Yandex Disk o mediante el proveedor local explícito `simulator`. La interfaz de gestión utiliza TypeScript sin un framework de interfaz.

## Inicio independiente

Ejecute `make start` desde este directorio. Instala las dependencias de compilación, compila el servicio, crea `.env` con claves aleatorias y una contraseña de base de datos, construye los contenedores Docker y espera a que estén listos. Conserva la configuración y los volúmenes existentes. Se necesitan este directorio, Docker Compose y Node.js 24; los demás repositorios de Timepost son opcionales.

Desde la raíz del workspace Timepost: `make files-standalone`. Entrada alternativa: `make -f scripts/main/Makefile files-standalone`.

Abra <http://127.0.0.1:3060>, introduzca `FILES_API_KEY` de su `.env` local y seleccione un ID numérico de espacio de trabajo. La interfaz permite listar con paginación incremental, subir, descargar y poner archivos en la cola de eliminación. La clave permanece en la memoria de la página. `FILES_READONLY_API_KEY` permite únicamente lectura.

Las claves independientes cubren toda la instancia y todos sus espacios; son credenciales de servicio, no permisos individuales de usuario. El puerto HTTP se publica solamente en loopback. El token OAuth permanece en el servidor. Mantenga `.env` privado.

| Comando                         | Función                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `make start`                    | Compilar e iniciar API, PostgreSQL y worker              |
| `make ps` / `make logs`         | Consultar contenedores y registros de API/worker         |
| `make stop`                     | Detener sin borrar los datos                             |
| `make config`                   | Validar Compose sin mostrar secretos                     |
| `make smoke`                    | Probar el simulador y borrar solo sus archivos de prueba |
| `make test-db`                  | Probar insert/get/list en PostgreSQL con rollback        |
| `make build` / `make typecheck` | Compilar / comprobar tipos estrictos                     |
| `make test` / `make lint`       | Ejecutar pruebas / ESLint y comprobación de formato      |
| `make docs`                     | Generar documentación HTML de la API                     |

El equivalente de `make smoke` en el workspace es `make files-smoke`.

## Configurar Yandex Disk

En `files/.env`, configure `STORAGE_PROVIDER=yandex` y `YANDEX_DISK_OAUTH_TOKEN`; ejecute de nuevo `make start`. El token debe permitir el acceso a la carpeta de la aplicación `app:/timepost`: [documentación oficial REST y OAuth](https://yandex.ru/dev/disk/rest/).

Los metadatos permanecen en PostgreSQL y los bytes se suben a Disk. Un fallo de la nube no activa el almacenamiento local. Los registros de otro proveedor se ocultan del listado; las consultas de metadatos/contenido devuelven un error de proveedor incompatible. No están implementadas las conexiones al Disk personal de cada usuario ni Google Drive. La ejecución real en la nube requiere un token válido y todavía no se ha verificado.

## API y ciclo de vida

Contrato: [openapi.json](openapi.json) y [openapi.yaml](openapi.yaml). Generación: `npm run openapi:generate`; comprobación: `npm run openapi:check`. No se expone un endpoint HTTP de Swagger. Es una API REST propia, no un esquema GraphQL ni una copia exacta de la API HTTP de Yandex Disk.

| Solicitud                                            | Comportamiento                                           |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `POST /api/v1/files?projectId=1&fileName=photo.png`  | Subir bytes con autenticación Bearer                     |
| `GET /api/v1/files?projectId=1&limit=20&cursor=UUID` | Listar archivos listos con paginación por cursor         |
| `GET /api/v1/files/{id}`                             | Consultar metadatos                                      |
| `GET /api/v1/files/{id}/content`                     | Descargar contenido privado                              |
| `DELETE /api/v1/files/{id}`                          | Devolver HTTP 202 y encolar una eliminación persistente  |
| `GET /api/v1/files/{id}/deletion`                    | Consultar estado e intentos, incluso después de eliminar |
| `GET /api/v1/storage`                                | Consultar capacidades de almacenamiento sin secretos     |
| `GET /health/ready`                                  | Comprobar disponibilidad                                 |

Imágenes y archivos genéricos: máximo 10 MiB (`10 × 1024 × 1024` bytes). Vídeos: máximo 100 MiB (`100 × 1024 × 1024` bytes). JPEG/PNG/WebP deben decodificarse correctamente, contener un solo fotograma y no superar 4096 × 4096 píxeles. ffprobe valida MP4 H.264/AAC y WebM VP8/VP9 con Opus/Vorbis: una pista de vídeo, como máximo una de audio, hasta 4096 × 4096 píxeles y 60 minutos. Los metadatos incluyen `durationSeconds`.

No se implementan HEIC, AVI, MOV, transcodificación, extracción de portadas ni decodificación completa de vídeo. La descarga autenticada de vídeo utiliza un Blob y el reproductor existente; la API admite un único rango HTTP; no hay cargas reanudables. Los archivos genéricos independientes se guardan como `application/octet-stream` y se descargan como adjuntos. No hay análisis antivirus.

Las descargas verifican el tamaño y SHA-256. Una carga pasa a `ready` cuando el proveedor la confirma. El worker encola la limpieza de cargas `pending` sin terminar después de 24 horas.

El archivo pasa por `deleting` → `deleted`; el trabajo por `pending` → `running` → `done`, reintento o `failed`. PostgreSQL conserva la cola y una concesión de 120 segundos. Tras 10 fallos procesados, el trabajo se detiene; repetir DELETE lo reactiva. Se conservan los metadatos eliminados para auditoría. La cola no necesita Redis, Kafka ni RabbitMQ. La API aplica migraciones secuencialmente bajo un bloqueo de base de datos. Configure las copias de seguridad de volúmenes/nube por separado.

## Integración con Timepost

Los comandos del workspace `make start`, `make dev` (alias de `dev-local`), `make dev-docker` y `make dev-local` incluyen Files. `make files-start` inicia Files y sus dependencias. El stack principal usa por defecto el simulador, sesiones de Accounts y comprobaciones de permisos de Projects. Para la nube, configure `FILES_STORAGE_PROVIDER=yandex` y `YANDEX_DISK_OAUTH_TOKEN` en el `.env` raíz.

El frontend utiliza `/api/files-service`. Posts valida `mediaFileId` mediante Files. La eliminación protege archivos vinculados y antiguos sin registrar. Las claves independientes no sustituyen los permisos de usuario de Timepost.

`make dev` ya prepara datos iniciales. `make seed` añade los registros de demostración que faltan en Accounts/Projects/Posts/Notifications y el catálogo Analytics; no reinicia una base de datos existente. Files crea bytes mediante cargas correctas, no archivos ficticios de seed. Reiniciar o ejecutar seed no vacía sus volúmenes.

Flujo del editor: navegador → `/api/files-service/api/v1/files` → Files → proveedor. Después, el navegador envía `mediaFileId` a Posts. Posts comprueba los metadatos con la sesión del usuario y guarda tipo image/video, dimensiones y referencia. Al reabrir el editor se devuelve el ID guardado sin otra carga. Reels y Stories utilizan el mismo flujo; esto no confirma la publicación en una red social.

Los avatares y las portadas pueden almacenarse técnicamente como imágenes de proyecto. Guardar sus referencias requiere un contrato del servicio propietario, Accounts/Projects. No está implementada la integración automática de todos los avatares, portadas y adjuntos de chat.

## Ejemplos de API independiente

Exporte localmente la clave desde `.env`; no la incluya en la documentación. Timepost utiliza un token Bearer del usuario.

```sh
# Subir una imagen; la respuesta contiene data.mediaFileId.
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  -H 'Content-Type: image/jpeg' --data-binary @photo.jpg \
  'http://127.0.0.1:3060/api/v1/files?projectId=1&fileName=photo.jpg'

# Para MP4, utilice video/mp4 y la ruta del archivo correspondiente.
# Listar archivos.
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  'http://127.0.0.1:3060/api/v1/files?projectId=1&limit=20'

# Asigne a FILE_ID el UUID devuelto por la carga.
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  "http://127.0.0.1:3060/api/v1/files/$FILE_ID/content" --output saved-file
curl --fail-with-body -X DELETE -H "Authorization: Bearer $FILES_API_KEY" \
  "http://127.0.0.1:3060/api/v1/files/$FILE_ID"
curl --fail-with-body -H "Authorization: Bearer $FILES_API_KEY" \
  "http://127.0.0.1:3060/api/v1/files/$FILE_ID/deletion"
```

## Relación con Yandex Disk

Ambos proveedores implementan la interfaz interna `ready/upload/download/delete` y mantienen el contrato externo de Files.

| Operación Files | Adaptador Yandex Disk                       | Simulador local                     |
| --------------- | ------------------------------------------- | ----------------------------------- |
| Preparación     | `PUT /resources` para `app:/timepost`       | Crear directorio                    |
| Upload          | `/resources/upload`, seguido de PUT binario | Escribir y sincronizar archivo UUID |
| Content         | `/resources/download`, seguido de GET       | Leer archivo UUID                   |
| Delete          | `DELETE /resources` con `permanently=true`  | Eliminar archivo UUID               |
| List/metadata   | Metadatos PostgreSQL del servicio           | Los mismos metadatos PostgreSQL     |

OAuth se envía únicamente a la API de Disk. Las URL temporales permanecen en el servidor; se comprueban HTTPS y dominios, y se rechazan redirecciones. HTTP 202 del proveedor no indica una carga terminada; las operaciones sin terminar permanecen pending. Fuentes: [adaptador](src/modules/files/infrastructure/storage/yandex-disk-storage.ts), [API REST de Yandex](https://yandex.ru/dev/disk/rest/), [introducción a Disk API](https://yandex.ru/dev/disk-api/doc/ru/) y [registro OAuth](https://www.yandex.ru/dev/id/doc/ru/register-client). Sigue siendo necesaria una prueba con un token real.

## Servidor propio

El proveedor explícito `simulator` guarda bytes reales en el volumen persistente `objects` y metadatos en `metadata`. Puede ejecutarse en su servidor. Configure copias de ambos volúmenes, un reverse proxy HTTPS y claves independientes. Mantenga PostgreSQL privado; Compose publica HTTP en loopback por defecto. En Timepost, Accounts gestiona los usuarios; el modo independiente utiliza claves de servicio.

Cambiar `simulator` ↔ `yandex` afecta a las nuevas cargas y no migra bytes existentes. Los registros de otro proveedor no están disponibles. La migración requiere copiar bytes, verificar checksums y actualizar metadatos; ese procedimiento no está implementado.

Sin Docker se necesitan PostgreSQL, Node.js 24 y ffprobe en PATH. Ejecute `npm ci`, exporte las variables de `.env.example`, después `npm run build` y `npm start`. Para un worker separado: `FILES_ROLE=worker npm start`. Node no carga `.env` automáticamente.

## TypeScript, arquitectura y documentación

API, worker, adaptadores, scripts, pruebas e interfaz utilizan TypeScript con `strict` y `noUncheckedIndexedAccess`. Los errores impiden emitir código. `npm run build` limpia `dist/`, compila y copia recursos de interfaz/fixtures. `npm start` ejecuta `dist/src/server.js`. Docker compila en una etapa separada; el runtime contiene dependencias de producción, migraciones, ffmpeg y API/worker/interfaz compilados.

```text
src/
  app/                         composición de dependencias e inicio API/worker
  modules/
    files/
      domain/                  modelo, estados y límites
      application/             operaciones y procesamiento de eliminación
        ports/                 contratos de repositorio, almacenamiento, medios e identidad
      infrastructure/          PostgreSQL, Yandex Disk, archivos, sharp/ffprobe
      presentation/            HTTP, DTO y OpenAPI
      contracts.ts             tipos públicos del módulo
    access/
      application/             autorización y acceso a proyectos
      infrastructure/          JWT Accounts/Projects y claves independientes
      contracts.ts             tipos públicos de acceso
  shared/                      errores, guards y contratos de infraestructura
  server.ts                    punto de entrada estable
```

`FileService` recibe interfaces mediante el constructor. Los errores de aplicación tienen códigos tipados; HTTP los convierte en estados. La validación de medios y generación UUID/checksum son adaptadores. Los contratos utilizan `Uint8Array` y `AsyncIterable`, sin depender de sharp, PostgreSQL ni HTTP `Response`. `app/create-file-service.ts` y `app/bootstrap.ts` componen las dependencias.

Tipos de dominio: `modules/files/domain/file.ts`; puertos: `application/ports`; DTO HTTP: `presentation/http/file-dto.ts`. La interfaz reutiliza DTO mediante `import type`. Los archivos `contracts.ts` de files/access exponen tipos públicos. La prueba de arquitectura comprueba la dirección de dependencias y el acceso mediante contratos públicos.

Comprobaciones: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`. `make test-db` revierte sus cambios de base de datos. `make smoke` crea PNG, MP4 y archivos genéricos, comprueba la lectura y elimina sus propios archivos.

`npm run openapi:docs` / `make docs` genera `documentation/index.html` con Redocly como dependencia local de desarrollo. `dist/` y `documentation/` están excluidos de Git.

En el workspace, `make api-sync` actualiza contratos y snapshots; `make api-check` comprueba consistencia y ejecuta el linter OpenAPI. `make api-docs` exporta manualmente HTML/JSON/YAML/ZIP a `archive/docs/`; `archive/docs/api/index.html` proporciona navegación. No son archivos necesarios para ejecutar el servicio ni se regeneran con dev, seed o api-sync. Redocly compartido pertenece a Scripts, no al frontend. `public/index.html` es la interfaz de gestión y `archive/docs/api/files.html` es la referencia API. Generadores del workspace: [contratos](../scripts/openapi-contracts.mjs), [HTML/ZIP](../scripts/openapi-handoff.mjs).

`make files-integration-smoke` comprueba Accounts/Projects → Files → borrador Reels de Posts → reapertura/actualización → contenido privado. Requiere cuenta/proyecto de seed y credenciales locales de `.env.seed`. Elimina su publicación y deja un archivo pequeño porque la eliminación directa en Timepost está bloqueada. No publica en redes sociales.

Informes opcionales del workspace: [servicio independiente](../archive/docs/reports/2026-10-02-files-standalone.md), [integración de medios](../archive/docs/reports/2026-10-02-files-media-integration.md), [arquitectura](../archive/docs/reports/2026-10-02-files-clean-architecture.md).

## Referencias, miniaturas y rangos

Posts registra `post:<id>` mediante `POST /api/v1/internal/file-references` con `{projectId, referenceId, fileIds, cleanupRemoved}`. Requiere JWT de sistema HS256 para `posts-service`, permiso `files:references:write` e issuer/audience configurados. Sesiones y claves autónomas no sirven. Solo archivos listos del mismo proyecto; bloqueos serializan registro y eliminación.

Tras el commit de eliminación permanente, liberar con `fileIds: []`, `cleanupRemoved: true`. Solo archivos anteriormente vinculados sin referencias restantes entran en la cola. Fallos de guardado pueden dejar referencias seguras que requieren reconciliación. Archivos antiguos sin registrar siguen protegidos. Eliminación pública exige `FILES_DELETE_ENABLED=true`, usuario que subió, escritura en proyecto y cero referencias; Timepost admite nuevas cargas con control completo, incluso antes del primer registro. No liberar antes del commit.

`GET /api/v1/files/{id}/thumbnail` genera WebP de hasta 512×512 para imágenes privadas. Contenido admite un único `Range: bytes=...` (206/416), con autorización y SHA-256 completos. Se descarga todo el original: Range reduce respuesta al cliente, no tráfico del proveedor. Miniaturas bajo demanda sin caché persistente; no hay posters de vídeo.

Las respuestas incluyen `X-Request-Id` validado y `Server-Timing: app`; la correlación se transmite a Accounts y Projects. `HTTP_REQUEST_LOG_ENABLED=true` activa registros de ruta, estado y duración sin tokens ni query. Descargas y miniaturas simultáneas se limitan a cuatro por instancia (429 si está ocupada).

Los archivos anteriores a la migración de referencias quedan protegidos incluso después del primer registro: publicaciones antiguas pueden utilizarlos. Su limpieza requiere una migración completa y verificada de referencias.

Tras recompilar, `make test-references` verifica referencias en PostgreSQL autónomo. Crea solo sus propios metadatos, sin bytes, y elimina esas filas.
