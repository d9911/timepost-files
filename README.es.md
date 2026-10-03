# Timepost Files

[English](README.md) · [Русский](README.ru.md) · [Español](README.es.md)

![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)
![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![REST API](https://img.shields.io/badge/API-REST-00897B)
![PWA](https://img.shields.io/badge/UI-PWA-5A0FC8)

Almacenamiento privado · Yandex Disk, S3 y proveedor local · API e interfaz en TypeScript

<details>
<summary>Contenido</summary>

[Almacenamiento compatible con S3](#almacenamiento-compatible-con-s3) · [Tecnologías](#tecnologías) · [Inicio independiente](#inicio-independiente) · [Configurar Yandex Disk](#configurar-yandex-disk) · [API y ciclo de vida](#api-y-ciclo-de-vida) · [Integración con Timepost](#integración-con-timepost) · [Ejemplos de API independiente](#ejemplos-de-api-independiente) · [Relación con Yandex Disk](#relación-con-yandex-disk) · [Servidor propio](#servidor-propio) · [TypeScript, arquitectura y documentación](#typescript-arquitectura-y-documentación) · [Referencias, miniaturas y rangos](#referencias-miniaturas-y-rangos) · [Idiomas, temas e identidad visual](#idiomas-temas-e-identidad-visual) · [PWA y otros formatos](#pwa-y-otros-formatos) · [Autor](#autor) · [Licencia](#licencia)

</details>

## Almacenamiento compatible con S3

S3 significa **Simple Storage Service**, no una versión 3 de la API. Amazon S3 es el servicio de AWS; Selectel y Yandex Object Storage ofrecen API compatibles. Yandex Disk utiliza otra API con OAuth. Files conserva `/api/v1/files`, la autorización, validación, PostgreSQL y la cola de eliminación.

Proveedores: `yandex` (Yandex Disk), `simulator` (sistema de archivos), `selectel`, `aws`, `yandex-object` y `s3` (endpoint compatible o S3Mock local).

Configure `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` y `S3_SECRET_ACCESS_KEY` en `.env`; ejecute `make start`. Use el endpoint y región/pool de su proveedor. Yandex Object Storage: `https://storage.yandexcloud.net`, `ru-central1`. AWS no requiere endpoint explícito; sin claves usa la cadena de credenciales del SDK, que debe configurarse dentro del contenedor. `S3_SESSION_TOKEN` permite credenciales temporales; `S3_FORCE_PATH_STYLE=true` es el valor predeterminado; `false` activa virtual-hosted. Prefijo: `S3_KEY_PREFIX=timepost/`. Las claves quedan en el servidor; la nube requiere HTTPS.

Use un bucket privado dedicado sin versionado ni historial previo. La comprobación de disponibilidad rechaza el versionado habilitado o suspendido para evitar conservar versiones antiguas después de DELETE. Se requieren permisos HeadBucket, GetBucketVersioning, PutObject, GetObject y DeleteObject. Los buckets de la nube no se crean automáticamente. No existe fallback local silencioso. Cambiar bucket, prefijo o endpoint no migra datos: use otra base de datos/instancia o una migración verificada.

### Prueba local S3

```sh
make start-s3
make smoke-s3
make logs-s3
make stop-s3
```

Abra `http://127.0.0.1:3060` (o `FILES_PORT` de `.env`). Todos los proveedores utilizan un único proyecto Compose `timepost-files-standalone`, con una API, PostgreSQL y worker. `make start-s3` selecciona S3 local en el mismo `.env`, conservando las claves Files, la contraseña de la base de datos y el puerto; añade Adobe S3Mock y la inicialización del bucket al mismo proyecto. `make start`, `stop`, `ps`, `logs` y `smoke` detectan el proveedor configurado. Los comandos `*-s3` de inspección son alias compatibles. `start-s3` no sobrescribe configuraciones de nube existentes.

Las credenciales S3 permanecen en el servidor. S3Mock no publica puertos y es un emulador de pruebas, no una prueba de IAM o firmas reales. La parada conserva los volúmenes. Para volver al simulador de archivos, configure `STORAGE_PROVIDER=simulator` en `.env` y ejecute `make start`. Los metadatos siguen en la misma base de datos; las listas muestran el proveedor seleccionado. Cambiar de proveedor no copia bytes ni cambia el proveedor de archivos existentes. Cambiar bucket/endpoint/prefix de S3 requiere una migración verificada.

Las instalaciones anteriores usaban `timepost-files-s3`, puerto 3061 y `.env.s3`. Deténgalas con `docker compose --env-file .env.s3 -p timepost-files-s3 -f compose.yaml -f compose.s3.yaml down` **sin `--volumes`**. Conserve configuración y volúmenes para recuperación; los datos antiguos no se importan automáticamente. Los comandos nuevos no crean un segundo proyecto.

Fuentes: [AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [Selectel](https://docs.selectel.ru/api/object-storage-s3/), [Yandex Object Storage](https://yandex.cloud/ru/docs/storage/s3/), [Adobe S3Mock](https://github.com/adobe/S3Mock). No se ha probado la nube real sin credenciales.

## Tecnologías

| Componente                    | Implementación                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| Entorno de ejecución          | Node.js 24, servidor HTTP nativo                                   |
| Lenguaje                      | TypeScript 5.9, tipado estricto                                    |
| Metadatos y cola de tareas    | PostgreSQL 16                                                      |
| Proveedores de almacenamiento | Yandex Disk / adaptador S3 con AWS SDK / sistema de archivos local |
| Procesamiento multimedia      | Sharp / ffprobe                                                    |
| Interfaz de gestión           | TypeScript, CSS, Web Manifest y service worker                     |
| Documentación de la API       | OpenAPI / Redocly                                                  |
| Calidad del código            | ESLint / Prettier / pruebas nativas de Node.js                     |

![Interfaz de escritorio](assets/screenshots/storage-desktop.png)

**Archivos privados, una vista más clara.** Una interfaz ligera con una ilustración 3D en CSS, animaciones sutiles y una lista adaptable. Las capturas muestran cargas reales en el simulador local dentro de un espacio de demostración; no muestran claves de acceso. Las animaciones respetan `prefers-reduced-motion`.

<details>
<summary>Interfaz móvil</summary>

<img src="assets/screenshots/storage-mobile.png" width="390" alt="Interfaz móvil" />

</details>

<details>
<summary>Tema oscuro / español</summary>

![Timepost Files — dark theme](assets/screenshots/storage-dark.png)

</details>

Servicio privado de almacenamiento de archivos con API REST, Node.js 24 y TypeScript. Ejecuta una API, PostgreSQL y un worker de eliminación. Los bytes se guardan en Yandex Disk, almacenamiento compatible con S3 o mediante el proveedor local explícito `simulator`. La interfaz de gestión utiliza TypeScript sin un framework de interfaz.

## Inicio independiente

Ejecute `make start` desde este directorio. Instala las dependencias de compilación, compila el servicio, crea `.env` con claves aleatorias y una contraseña de base de datos, construye los contenedores Docker y espera a que estén listos. Conserva la configuración y los volúmenes existentes. Se necesitan este directorio, Docker Compose y Node.js 24; los demás repositorios de Timepost son opcionales.

Desde la raíz del workspace Timepost: `make files-standalone`. Entrada alternativa: `make -f scripts/main/Makefile files-standalone`.

Para iniciar ambos proyectos desde el workspace Timepost: `make dev-file` (desarrollo local del frontend) o `make start-file` (compilación e inicio en Docker). Primero compilan e inician Files independiente y después el modo normal de Timepost; abren Timepost, Admin y Files cuando están listos. `OPEN_BROWSER=false` desactiva la apertura. También funcionan mediante `make -f scripts/main/Makefile`. Files independiente conserva datos y claves separados, se recompila al ejecutar el comando y no tiene hot reload. Puerto personalizado: `FILES_PORT=4060 FILES_UI_URL=http://127.0.0.1:4060`. Para detenerlo desde el workspace: `make -C files stop`.

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

### Obtener y reemplazar una clave de acceso

Ejecute `make setup` en `files/`: crea un `.env` privado en el primer uso y conserva las claves existentes. Introduzca `FILES_API_KEY` en el campo de acceso; `FILES_READONLY_API_KEY` permite solo lectura. Los clientes HTTP envían `Authorization: Bearer <clave Files>`. Las credenciales S3 no autentican a Files.

Para generar una clave de prueba:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copie el resultado a `FILES_API_KEY` o `FILES_READONLY_API_KEY` en `.env` y ejecute `make start`. Use claves distintas de al menos 32 caracteres. La clave reemplazada deja de funcionar tras recrear la API; `make setup` no rota claves. No cambie `FILES_DB_PASSWORD`.

Solo se admiten una clave completa y una de lectura para toda la instancia. No hay registro ni claves independientes por cliente. Para permisos de usuario utilice Timepost con Accounts/Projects. No publique claves en Git o URL ni introduzca credenciales de nube en el navegador.

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

`make files-integration-smoke` comprueba Accounts/Projects → Files → borrador Reels de Posts → reapertura/actualización → contenido privado. Requiere cuenta/proyecto de seed y credenciales locales de `.env.seed`. Elimina su publicación y archivo, espera al worker y cierra su sesión de prueba. No publica en redes sociales.

Informes opcionales del workspace: [servicio independiente](../archive/docs/reports/2026-10-02-files-standalone.md), [integración de medios](../archive/docs/reports/2026-10-02-files-media-integration.md), [arquitectura](../archive/docs/reports/2026-10-02-files-clean-architecture.md).

## Referencias, miniaturas y rangos

Posts registra `post:<id>` mediante `POST /api/v1/internal/file-references` con `{projectId, referenceId, fileIds, cleanupRemoved}`. Requiere JWT de sistema HS256 para `posts-service`, permiso `files:references:write` e issuer/audience configurados. Sesiones y claves autónomas no sirven. Solo archivos listos del mismo proyecto; bloqueos serializan registro y eliminación.

Tras el commit de eliminación permanente, liberar con `fileIds: []`, `cleanupRemoved: true`. Solo archivos anteriormente vinculados sin referencias restantes entran en la cola. Fallos de guardado pueden dejar referencias seguras que requieren reconciliación. Archivos antiguos sin registrar siguen protegidos. Eliminación pública exige `FILES_DELETE_ENABLED=true`, usuario que subió, escritura en proyecto y cero referencias; Timepost admite nuevas cargas con control completo, incluso antes del primer registro. No liberar antes del commit.

`GET /api/v1/files/{id}/thumbnail` genera WebP de hasta 512×512 para imágenes privadas. Contenido admite un único `Range: bytes=...` (206/416), con autorización y SHA-256 completos. Se descarga todo el original: Range reduce respuesta al cliente, no tráfico del proveedor. Miniaturas bajo demanda sin caché persistente; no hay posters de vídeo.

Las respuestas incluyen `X-Request-Id` validado y `Server-Timing: app`; la correlación se transmite a Accounts y Projects. `HTTP_REQUEST_LOG_ENABLED=true` activa registros de ruta, estado y duración sin tokens ni query. Descargas y miniaturas simultáneas se limitan a cuatro por instancia (429 si está ocupada).

Los archivos anteriores a la migración de referencias quedan protegidos incluso después del primer registro: publicaciones antiguas pueden utilizarlos. Su limpieza requiere una migración completa y verificada de referencias.

Tras recompilar, `make test-references` verifica referencias en PostgreSQL autónomo. Crea solo sus propios metadatos, sin bytes, y elimina esas filas.

## Idiomas, temas e identidad visual

La acción Vista previa abre imágenes/GIF, vídeo y audio reconocido en un modal con controles nativos. El fondo, la cruz y Escape cancelan la carga, detienen la reproducción y liberan la URL Blob. No se muestran SVG ni HTML. Antes de subir se consultan todas las páginas de nombres; las coincidencias ofrecen un sufijo o conservar el nombre original. Es una sugerencia de interfaz: los UUID del servidor evitan sobrescrituras, incluso en cargas concurrentes. Las secciones aparecen al entrar en pantalla y respetan movimiento reducido.

La interfaz se abre en inglés y admite ruso y español. La cabecera fija ofrece temas claro, oscuro y del sistema. Solo estas preferencias se guardan en localStorage; la clave queda en la memoria de la pestaña.

`npm run icons:generate` genera PNG de 16–1024 px, favicon SVG/ICO, Apple touch icon, un icono maskable, una imagen social y `public/manifest.webmanifest`. Fuente: `assets/branding/icon.svg`; recursos: `public/icons/`; módulos TypeScript: `public/*.ts`. `npm run build` compila los módulos y copia los recursos a `dist/public/`. Un service worker versionado almacena solo la interfaz pública; la API y los archivos privados requieren el servidor. [Seguridad del despliegue](SECURITY.md).

El selector de archivos utiliza un control SVG con enfoque visible del teclado. La cabecera fija se oculta al bajar y vuelve al subir o recibir enfoque. Las secciones aparecen una vez al entrar en pantalla; el modo de movimiento reducido las mantiene visibles sin animación. La barra de desplazamiento sigue el tema claro/oscuro (gradiente en Chromium, color sólido en Firefox). El pie incluye al desarrollador y el repositorio. El desplazamiento usa un listener pasivo, actualizaciones por fotograma y observación única de las secciones.

## PWA y otros formatos

El manifest enumera todos los tamaños PNG de 16–1024 px y el icono maskable. El navegador elige el tamaño apropiado; no descarga todo el conjunto. El worker almacena solo la interfaz pública y los iconos principales. Excluye API, Authorization, consultas, cargas y contenido privado. Las actualizaciones esperan al cierre de las pestañas antiguas y eliminan solo las cachés anteriores de Files.

Tras la primera visita en línea, la interfaz puede abrirse sin conexión. Un aviso desactiva las operaciones del servidor. No existe una cola de cargas sin conexión ni una copia local de la biblioteca. El despliegue requiere HTTPS; loopback funciona para desarrollo. [Documentación de Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

Con `FILES_GENERIC_ENABLED=true` (predeterminado en modo autónomo), audio, GIF animados, SVG y archivos arbitrarios conservan sus bytes y nombres, pero se descargan como adjuntos `application/octet-stream`. SVG no se ejecuta en la página. El límite es 10 MiB; no se añaden reproductores, miniaturas ni validación de estos formatos. JPEG/PNG/WebP y MP4/WebM se validan por separado; el vídeo tiene un límite de 100 MiB. Almacenar un formato no implica poder publicarlo en redes sociales.

## Autor

Denis Gutsuliak · [d9911.org](https://d9911.org).

## Licencia

Consulte las condiciones completas en [LICENSE](LICENSE).

[![License](https://img.shields.io/badge/license-see_LICENSE-blue)](LICENSE)
