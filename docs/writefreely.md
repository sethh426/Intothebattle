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

The main app exposes stable redirect routes:

```text
GET /blog
GET /updates
```

Set `WRITEFREELY_PUBLIC_URL` when the blog should redirect somewhere other than `http://localhost:8080/`.

## App Integration

The main Express app redirects `/blog` and `/updates` to:

```text
WRITEFREELY_PUBLIC_URL
WRITEFREELY_URL
http://localhost:8080/
```

The first configured value wins. Keep a trailing slash optional; the app normalizes it.

Local example:

```powershell
$env:WRITEFREELY_PUBLIC_URL = 'http://localhost:8080/'
npm start
```

Production examples:

```text
WRITEFREELY_PUBLIC_URL=https://blog.intothebattle.com/
```

or:

```text
WRITEFREELY_PUBLIC_URL=https://intothebattle.com/blog/
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
