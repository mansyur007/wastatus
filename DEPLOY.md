# Deploy — wastatus.emha.space

WA Status Converter di VPS EMHA Universe (`103.169.207.239`), di belakang front
door bersama `emha-caddy`. Aturan estate: lihat skill `emha-deploy` / `emha-docker`
di repo `emhauniverse`.

## Bentuk deploy

App ini **100% client-side** (ffmpeg.wasm di browser). Tidak ada backend, tidak ada
state, tidak ada `.env`, tidak ada volume — containernya hanya static file server.

| Item | Nilai |
| --- | --- |
| URL | https://wastatus.emha.space |
| VPS dir | `/opt/wa-status` |
| Container : port | `wa-status:8080` (internal, tanpa host port) |
| Network | `emha_shared` (external) |
| State | tidak ada — redeploy = image baru, aman total |

**`dist/` dibangun di mesin dev / CI, bukan di VPS.** RAM VPS cuma ~600Mi free;
`tsc -b && vite build` di sana berisiko OOM-kill container estate lain. Dockerfile
hanya `COPY dist /srv`.

## Prasyarat sekali jalan

1. **A record** `wastatus.emha.space` → `103.169.207.239`. Wajib duluan — tanpa itu
   Caddy tidak bisa terbitkan sertifikat Let's Encrypt (tidak ada wildcard DNS).
2. Network estate sudah ada (`docker network create emha_shared` — sudah dibuat).
3. Key SSH `~/.ssh/development` ada di mesin yang men-deploy.
4. **Route di Caddyfile repo `emhauniverse`** (bukan diedit di VPS saja — deploy
   portal rsync `--delete` dan akan menimpanya):

   ```
   wastatus.emha.space {
   	encode gzip
   	reverse_proxy wa-status:8080
   }
   ```

   Header COOP/COEP di-set oleh container wa-status sendiri dan diteruskan Caddy.
   Setelah commit + push emhauniverse (atau edit manual di VPS pakai `cat >`):

   ```bash
   cd /opt/emhauniverse && docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
   ```

   `caddy reload` TIDAK cukup — Caddyfile di-bind-mount sebagai file tunggal,
   rsync menukar inode-nya (gotcha #2 di skill `emha-deploy`).

## Deploy rutin

```bash
bash scripts/deploy-vps.sh
```

Script itu: `npm run build` → kirim `dist/` + file container lewat `tar | ssh`
(mesin Windows ini tidak punya rsync) → `docker compose up -d --build` di VPS →
smoke test. `dist/` di VPS dihapus dulu tiap deploy supaya asset hash lama tidak
menumpuk.

Override via env: `KEY=`, `HOST=`, `DIR=`, `URL=`.

## Troubleshooting

```bash
ssh -i ~/.ssh/development root@103.169.207.239
docker compose -f /opt/wa-status/docker-compose.prod.yml logs -f --tail=50 wa-status
docker network inspect emha_shared | grep -A3 wa-status     # container nyantol?
docker exec emha-caddy wget -qO- http://wa-status:8080/healthz   # reachable dari Caddy?
```

- **502 / no upstream** → container tidak join `emha_shared`, atau nama/port berubah.
- **Sertifikat gagal** → A record belum ada / belum propagasi.
- **wasm gagal load** → cek `Content-Type: application/wasm` dan header COOP/COEP
  ikut sampai di response (`curl -sI https://wastatus.emha.space/ffmpeg/ffmpeg-core.wasm`).
- **Update tidak kelihatan** → asset Vite di-cache immutable setahun; `index.html`
  `no-cache` jadi normalnya langsung ikut. Hard refresh kalau ragu.
