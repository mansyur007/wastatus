# Deploy — wastatus.emha.space

WA Status Converter di VPS EMHA Universe (`103.169.207.239`), di belakang front
door bersama `emha-caddy`. Aturan estate: lihat skill `emha-deploy` / `emha-docker`
di repo `emhauniverse`.

**Status: live** — https://wastatus.emha.space (sertifikat Let's Encrypt terbit
2026-08-21, `crossOriginIsolated: true` terverifikasi dari browser publik).

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

**`dist/` dibangun di mesin dev / CI runner, bukan di VPS.** RAM VPS cuma ~500Mi
bebas; `tsc -b && vite build` di sana berisiko OOM-kill container estate lain.
Dockerfile hanya `COPY dist /srv` + prakompresi.

**Prakompresi.** Core ffmpeg 32 MB di-gzip **sekali saat build image** (sidecar
`.gz`, disajikan lewat `file_server { precompressed gzip }`). Sebelum ini Caddy
meng-gzip tiap permintaan: 1.14 s CPU per hit. Sekarang 0.23 s dan sedikit lebih
kecil (10.2 MB vs 10.8 MB, karena `gzip -9`).

## Prasyarat (sudah beres semua)

1. A record `wastatus.emha.space` -> `103.169.207.239` — **aktif**.
2. Network estate `emha_shared` — sudah ada.
3. Key SSH `development` (di mesin ini ada di `~/Documents/mansyur-personal/.ssh/`).
4. Route di Caddyfile — **sudah dipasang di VPS**, tapi lihat peringatan di bawah.

## Route Caddy belum ter-commit di repo emhauniverse

Blok ini sudah ditambahkan langsung ke `/opt/emhauniverse/Caddyfile` (append
in-place, inode terjaga, `caddy reload` sudah jalan):

```
wastatus.emha.space {
	encode gzip
	reverse_proxy wa-status:8080
}
```

Deploy portal berikutnya melakukan rsync `--delete` dan **akan menghapus route ini**
kalau belum ada di repo `emhauniverse`. Commitnya sudah disiapkan di branch
`feat/wastatus-route` (worktree lokal), tinggal push + merge ke `main`.

## Deploy rutin

Otomatis lewat GitHub Actions tiap push ke `main` (`.github/workflows/deploy.yml`):
build di runner -> rsync `dist/` + file container -> `compose up -d --build` -> smoke
test. Butuh 3 secret di repo:

| Secret | Nilai |
| --- | --- |
| `VPS_HOST` | `103.169.207.239` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | private key deploy (disarankan key khusus `wastatus-ci`, bukan `development` yang memegang seluruh estate) |

Manual (tanpa Actions), dari mesin yang punya key:

```bash
bash scripts/deploy-vps.sh
```

Script itu build lokal lalu kirim lewat `tar | ssh` (mesin Windows tidak punya
rsync). Override via env: `KEY=`, `HOST=`, `DIR=`, `URL=`.

## Troubleshooting

```bash
ssh -i ~/Documents/mansyur-personal/.ssh/development root@103.169.207.239
docker compose -f /opt/wa-status/docker-compose.prod.yml logs -f --tail=50 wa-status
docker exec emha-caddy wget -qO- http://wa-status:8080/healthz
```

- **502 / no upstream** -> container tidak join `emha_shared`, atau nama/port berubah.
- **404 setelah deploy portal** -> route Caddy kehapus, lihat peringatan di atas.
- **wasm gagal load** -> cek `Content-Type: application/wasm` + COOP/COEP sampai ke
  klien: `curl -sI https://wastatus.emha.space/ffmpeg/ffmpeg-core.wasm`.
- **Update tidak kelihatan** -> aset Vite di-cache immutable setahun, tapi
  `index.html` `no-cache` jadi normalnya langsung ikut. Hard refresh kalau ragu.
