# WA Status Converter

Konverter video ke format WhatsApp Status yang berjalan **sepenuhnya di browser** —
ffmpeg.wasm, tanpa server, file tidak pernah diunggah ke mana pun.

```bash
npm install
npm run dev
```

Buka http://localhost:5173. Build produksi: `npm run build` (hasil di `dist/`).

## Aplikasi Windows (Electron + FFmpeg native)

```bash
npm run electron:dev     # jendela desktop menempel ke Vite dev server
npm run electron:start   # build produksi lalu jalankan di jendela desktop
npm run electron:build   # installer NSIS + portable .exe di release/
```

Hasil build ada di `release/`: satu installer NSIS dan satu `.exe` portable
(~172 MB masing-masing; ~611 MB setelah terpasang, karena Electron plus dua
binary FFmpeg statis). `ffmpeg.exe` dan `ffprobe.exe` masing-masing ~100 MB dan
sebagian besar isinya sama; memakai build "shared" FFmpeg akan memangkas ini
banyak, dengan biaya menambah beberapa DLL.

Versi desktop memakai **FFmpeg native yang dibundel**, bukan ffmpeg.wasm.
Letakkan `ffmpeg.exe` dan `ffprobe.exe` di `resources/ffmpeg/`; electron-builder
menyalinnya ke `resources/ffmpeg` di dalam aplikasi terpasang.

Kenapa ini penting: ffmpeg.wasm single-thread jalan di ~0.04x kecepatan FFmpeg
asli. Binary native memakai seluruh core CPU, jadi encode yang tadinya puluhan
detik jadi hitungan detik - dan itu dikalikan lagi oleh auto split.

Pemilihan mesin otomatis dan aman:

- `electron/preload.ts` memasang `window.waNative`. Renderer **tidak pernah**
  memegang `ipcRenderer` atau shell; ia hanya bisa memanggil beberapa operasi
  bernama, dan **proses main yang menyusun sendiri seluruh argumen FFmpeg** dari
  objek settings - jadi tidak ada jalan menyelundupkan flag dari renderer.
- `src/lib/engine.ts` memilih backend: native kalau jembatannya ada **dan**
  binary-nya betul ada, selain itu jatuh kembali ke wasm. Header aplikasi
  menampilkan mesin yang sedang dipakai.
- Proses main mengimpor `ffmpegArgs`/`bitrate`/`presets` yang sama persis
  dengan yang dipakai browser (lihat `scripts/build-electron.mjs`), jadi build
  desktop dan web menghasilkan perintah FFmpeg yang identik.
- File yang di-drop dibaca langsung dari path aslinya lewat
  `webUtils.getPathForFile` - tidak ada penyalinan file besar ke memori.

Di desktop tombol Download membuka dialog Simpan asli, dan **Download semua**
menulis seluruh bagian ke satu folder dengan sekali pilih.

Kalau `electron-builder` gagal dengan `EPERM ... rename win-unpacked.tmp`,
hentikan dulu Vite dev server: file watcher-nya memegang handle direktori
project dan Windows menolak rename direktori yang sedang dipantau.

Catatan lisensi: build FFmpeg dengan libx264 berlisensi GPL. Untuk pemakaian
pribadi tidak masalah; kalau mau didistribusikan, ikuti kewajiban GPL-nya.

## Cara kerja

- `scripts/copy-ffmpeg-core.mjs` menyalin core ffmpeg.wasm + module worker ke
  `public/ffmpeg/`, jadi aplikasi tidak bergantung pada CDN dan tidak terpengaruh
  cara bundler menangani worker/wasm. Skrip ini dijalankan otomatis pada
  `postinstall`, `dev`, dan `build`.
- Header COOP/COEP sudah dipasang di `vite.config.ts` supaya nanti bisa langsung
  ditukar ke `@ffmpeg/core-mt` (multi-thread) bila perlu.
- Metadata cepat (durasi/resolusi) dibaca dari elemen `<video>`; fps, codec, dan
  ada/tidaknya audio dibaca lewat `ffprobe` begitu core selesai dimuat.

## Preset default (dipakai begitu video di-load)

| Item | Nilai |
| --- | --- |
| Resolusi | 720 x 1280 (plafon WhatsApp) |
| Aspek | Crop to fill (9:16) |
| Durasi | Seluruh video, dipecah otomatis tiap 30 s |
| Target ukuran | 15 MB **per bagian** (mode target size, 2-pass) |
| Video | H.264 High, yuv420p, preset `faster` |
| Audio | AAC 128 kbps stereo 44.1 kHz |
| FPS | Cap 30 bila sumber > 31 fps, selain itu ikut sumber |
| Faststart | ON |

FPS otomatis di-cap ke 30 untuk sumber 60 fps: memangkas frame rate adalah
penghematan ukuran termurah sebelum menyentuh resolusi atau bitrate.

## Kenapa 720p, bukan 1080p

WhatsApp tidak pernah mengantar video di atas **720p**: jalur Standard meng-encode
ulang ke 480p, dan jalur HD pun mentok di 720p. Piksel di atas itu tidak pernah
sampai ke penonton.

Dengan budget 15 MB per bagian, memilih 720x1280 berarti tiap piksel dapat jauh
lebih banyak bit:

| Resolusi | bitrate/bagian | bits per pixel @30fps |
| --- | --- | --- |
| 720 x 1280 | 3940 kbps | **0.143** |
| 1080 x 1920 | 3940 kbps | 0.063 |

Di sekitar 0.14 bpp H.264 praktis bebas artefak; di 0.063 bpp artefak mulai
terlihat pada adegan bergerak. Ditambah encode ~2x lebih cepat karena pikselnya
2.25x lebih sedikit. 1080p tetap tersedia di panel, dengan peringatan.

**Tombol HD tidak tersedia untuk Status.** Menurut dokumentasi WhatsApp, HD hanya
ada di preview media dalam chat - Status yang diposting langsung selalu lewat
jalur kompresi standar. Karena itu alur "kirim ke chat pribadi pakai HD, lalu
forward ke Status Saya" bukan sekadar tips, tapi satu-satunya cara menyentuh
encoder HD. Enkripsi end-to-end membuat server WhatsApp tidak bisa melakukan
transcoding, jadi seluruh kualitas ditentukan encoder di perangkat pengirim -
yang juga menjelaskan kenapa hasilnya beda antar versi dan platform.

## Auto split

WhatsApp memotong Status yang lebih dari 30 detik di batasnya sendiri. Dengan
auto split (aktif secara default) pemotongan dilakukan di sini, sehingga:

- **Titik potongnya terkendali** — tiap bagian keluar sebagai file terpisah,
  `..._bagian1-dari-3.mp4`, `..._bagian2-dari-3.mp4`, dst (nomor di-pad supaya
  urut di file manager).
- **Tiap bagian punya jatah ukurannya sendiri.** Bitrate dihitung dari bagian
  *terpanjang*, bukan dari total klip — jadi target 15 MB berlaku per bagian,
  dan ekor pendek (mis. 5 detik) ikut bitrate yang sama lalu keluar lebih kecil,
  bukan dipaksa mengisi 15 MB.
- Sisa ekor di bawah 0.25 detik dibuang, tidak dijadikan Status sendiri.
- Pass 1 tiap bagian menulis `-passlogfile wapass<i>` sendiri, jadi statistik
  2-pass tidak pernah bocor antar bagian.

Panjang tiap bagian bisa dipilih **30 s** (default) atau **60 s**: WhatsApp
menaikkan batas Status dari 30 ke 60 detik mulai build 2024, tapi belum semua
versi punya. Kalau Status masih terpotong di 30 detik, kembalikan ke 30 s.

Panel memperlihatkan jumlah bagian sebelum konversi, dan panel hasil punya
tombol **Download semua**. Upload berurutan dari bagian 1 supaya Status tampil
sesuai urutan.

Matikan auto split lewat toggle di panel untuk kembali ke perilaku satu file;
kontrol **Batas durasi** (30/60/90 s) muncul lagi saat toggle mati.

## Pemetaan panel ke perintah FFmpeg

Semua argumen dibangun di [`src/lib/ffmpegArgs.ts`](src/lib/ffmpegArgs.ts), dan
perintah lengkapnya bisa dilihat langsung di panel ("Lihat perintah FFmpeg").

**Trim** — seek di sisi input, lalu batasi durasi:

```
-ss <trimStart> -i input.mp4 -t <durasi>
```

**Crop to fill** (`aspectMode: crop`, slider X/Y jadi offset 0..1):

```
-vf "fps=30,scale=720:1280:force_original_aspect_ratio=increase,
     crop=720:1280:(iw-ow)*0.500:(ih-oh)*0.500,format=yuv420p"
```

**Black bars** (`aspectMode: pad`):

```
-vf "scale=720:1280:force_original_aspect_ratio=decrease,
     pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p"
```

**Blurred background** (`aspectMode: blur`):

```
-filter_complex "[0:v]split=2[bg][fg];
  [bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,
      boxblur=luma_radius=29:luma_power=1:chroma_radius=15:chroma_power=1[bgb];
  [fg]scale=720:1280:force_original_aspect_ratio=decrease[fgs];
  [bgb][fgs]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,format=yuv420p[v]"
-map "[v]"
```

**Target ukuran (2-pass).** Bitrate video = `(targetMB x 1024 x 1024 x 8 / 1000)
x 0.97 / durasi - bitrateAudio` (faktor 0.97 untuk overhead container):

```
pass 1: ... -c:v libx264 -b:v <N>k -pass 1 -passlogfile wapass -an -f null /dev/null
pass 2: ... -c:v libx264 -b:v <N>k -maxrate <1.45N>k -bufsize <2N>k -pass 2
        -c:a aac -b:a 128k -ac 2 -ar 44100 -movflags +faststart -y output.mp4
```

Kalau hasilnya masih di atas 16 MB, bitrate diturunkan 10% dan encode diulang
(maksimum 2 kali), sesuai spesifikasi 5.4.4.

**Kualitas (CRF).** Satu pass, `-crf 18..30`; field bitrate berubah jadi batas
`-maxrate`/`-bufsize` (isi 0 untuk tanpa batas).

## Catatan kualitas

- WhatsApp **selalu** mengompres ulang. Sumber yang sudah rapi menghasilkan akhir
  yang lebih baik daripada file mentah besar.
- Isi budget-nya, jangan turunkan bitrate. Bitrate rendah membekukan artefak yang
  lalu ikut di-encode ulang oleh WhatsApp - rusak dua kali.
- Untuk klip pendek (di bawah ~10 detik) mode target-ukuran menghasilkan bitrate
  berlebihan (5 detik @ 15 MB = ~24 Mbps). Pakai mode CRF 18-20 di situ.
- Tips HD: kirim dulu ke chat pribadi dengan tombol HD, lalu forward ke
  "Status Saya". HD tidak tersedia langsung untuk Status.
- Status di atas 30 detik dipecah WhatsApp menjadi beberapa potongan 30 detik —
auto split mendahului itu supaya titik potongnya kamu yang tentukan.

## Struktur

```
src/
  lib/presets.ts      konstanta WA, preset default, dimensi target, safe zone
  lib/bitrate.ts      segmentPlan (auto split), target size -> bitrate, estimasi
  lib/ffmpegArgs.ts   filter chain + argumen FFmpeg (+ preview perintah)
  lib/ffmpegClient.ts load core, ffprobe, 2-pass per bagian, progress, auto-retry
  components/         Dropzone, Preview (safe zone), Panel, Result
  components/icons.tsx  ikon SVG inline (tanpa dependensi, tanpa emoji)
  lib/engine.ts       pemilih backend: FFmpeg native (Electron) atau wasm
electron/
  main.ts             jendela, spawn FFmpeg native, 2-pass per bagian, progress
  preload.ts          jembatan IPC minimal (window.waNative)
```

## Catatan performa

ffmpeg.wasm di sini single-thread. Sebagai gambaran: klip 8 detik ke 1080x1920
2-pass memakan ~65 detik — dan auto split mengalikan itu dengan jumlah bagian,
karena tiap bagian di-encode sendiri.

Default 720x1280 memangkas itu kira-kira setengah (2.25x lebih sedikit piksel),
yang kurang lebih menutupi biaya preset `faster`. Untuk lebih cepat lagi, pakai
mode CRF (satu pass) atau preset `Cepat` di panel.

`@ffmpeg/core-mt` (multi-thread) sudah ditinjau dan **sengaja tidak dipakai**:
percepatannya hanya ~2x, dokumentasi resminya menandai versi multi-thread sebagai
tidak stabil, ia mengalokasikan 1024 MB memori tetap, dan ia butuh cross-origin
isolation (SharedArrayBuffer) yang tidak dijamin ada di WebView Android pada
build Capacitor. Turun ke 720p memberi percepatan sebanding tanpa risiko itu.
Paket `@ffmpeg/ffmpeg` dan `@ffmpeg/core` sudah di versi terbaru
(0.12.15 / 0.12.10).

## Sumber

Angka 480p/720p dan status fitur HD berasal dari:
[TechCrunch](https://techcrunch.com/2023/08/25/whatsapp-rolls-out-support-for-hd-video),
[9to5Mac](https://9to5mac.com/2023/08/24/whatsapp-hd-videos/),
[WhatsApp Help Center](https://faq.whatsapp.com/759301289012856/),
[WABetaInfo - status 60 detik](https://wabetainfo.com/whatsapp-news-of-the-week-share-videos-of-up-to-1-minute-in-length-via-status-updates/),
[WABetaInfo - HD untuk status, masih dikembangkan](https://wabetainfo.com/whatsapp-news-of-the-week-high-quality-photos-and-videos-for-status-updates/).
