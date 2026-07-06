# WriteFreely Blog Setup

IntoTheBattle uses WriteFreely as a separate blogging service. The local install lives in `writefreely/`, which is ignored by git because it contains the downloaded binary, SQLite database, encryption keys, logs, PID file, and local admin credentials.

## Local Instance

Current local setup:

```text
WriteFreely version: 0.16.0
Blog URL: http://localhost:8080/
Login URL: http://localhost:8080/login
Install directory: writefreely/
Database: writefreely/writefreely.db
Admin credentials: writefreely/ADMIN_CREDENTIALS.txt
```

Start it from the repo root:

```powershell
.\scripts\start_writefreely.ps1
```

Stop it from the repo root:

```powershell
.\scripts\stop_writefreely.ps1
```

The main app exposes stable blog routes backed by the local `local_blog_posts` table:

```text
GET /blog
GET /updates
GET /blog/:slug
GET /api/public/blog-posts
```

Set `WRITEFREELY_PUBLIC_URL` to the public WriteFreely origin when admin-posted articles should link back to WriteFreely.

## App Integration

The main Express app renders local published posts at `/blog` and can also push posts to WriteFreely from the admin blog screen:

```text
GET  /admin/blog
GET  /admin/blog/manual
POST /admin/blog/manual
POST /admin/blog/:id/push
POST /admin/blog/site-context/push
POST /admin/blog/site-context/generate-and-push
```

Supported publishing configuration:

```text
WRITEFREELY_API_URL=http://localhost:8080
WRITEFREELY_PUBLIC_URL=http://localhost:8080/
WRITEFREELY_COLLECTION_ALIAS=owner
WRITEFREELY_SINGLE_USER=true
WRITEFREELY_API_TOKEN=
WRITEFREELY_USERNAME=
WRITEFREELY_PASSWORD=
WRITEFREELY_LOCAL_CREDENTIALS_PATH=
WRITEFREELY_DISABLE_LOCAL_CREDENTIALS=false
```

Use `WRITEFREELY_API_TOKEN` when you already have a token. Otherwise set `WRITEFREELY_USERNAME` and `WRITEFREELY_PASSWORD`; the app logs in through `/api/auth/login` and uses the returned access token for that publish request.

For a localhost WriteFreely bridge, if no API token or username/password env vars are set, the app automatically reads `writefreely/ADMIN_CREDENTIALS.txt`. Set `WRITEFREELY_LOCAL_CREDENTIALS_PATH` only if that ignored local credentials file lives somewhere else. Set `WRITEFREELY_DISABLE_LOCAL_CREDENTIALS=true` to force explicit env credentials only.

Legacy webhook publishing is still supported:

```text
WRITEFREELY_POST_WEBHOOK_URL=
WRITEFREELY_POST_WEBHOOK_TOKEN=
```

Local example:

```powershell
$env:WRITEFREELY_API_URL = 'http://localhost:8080'
$env:WRITEFREELY_PUBLIC_URL = 'http://localhost:8080/'
$env:WRITEFREELY_COLLECTION_ALIAS = 'owner'
$env:WRITEFREELY_SINGLE_USER = 'true'
$env:WRITEFREELY_USERNAME = 'owner'
$env:WRITEFREELY_PASSWORD = '<local admin password>'
npm start
```

Production examples:

```text
WRITEFREELY_PUBLIC_URL=https://blog.intothebattle.com/
WRITEFREELY_API_URL=https://blog.intothebattle.com/
WRITEFREELY_COLLECTION_ALIAS=owner
WRITEFREELY_SINGLE_USER=true
```

or:

```text
WRITEFREELY_PUBLIC_URL=https://intothebattle.com/blog/
WRITEFREELY_API_URL=https://blog.intothebattle.com/
WRITEFREELY_COLLECTION_ALIAS=owner
WRITEFREELY_SINGLE_USER=false
```

Use a subdomain unless a reverse proxy is explicitly configured to mount WriteFreely below `/blog/`.

## Reinstall Notes

The local binary came from the official WriteFreely GitHub release:

```text
https://github.com/writefreely/writefreely/releases/tag/v0.16.0
```

The downloaded Windows asset was:

```text
writefreely_0.16.0_windows_amd64.zip
sha256 fc32b76b6ff4cfafa8f90b62d2420b08c8bc65696666ab4b60aae9890a63b785
```

Useful WriteFreely commands, run inside `writefreely/`:

```powershell
.\writefreely.exe config generate
.\writefreely.exe keys generate
.\writefreely.exe db init
.\writefreely.exe user create --admin "owner:replace_with_a_strong_password"
.\writefreely.exe serve
```

Official start guide:

```text
https://writefreely.org/start
```
