# WA Status Converter

Konverter video ke format WhatsApp Status yang berjalan **sepenuhnya di
perangkat** — WebCodecs (encoder hardware) dengan ffmpeg.wasm sebagai cadangan,
tanpa server, file tidak pernah diunggah ke mana pun.

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

## Mesin di browser: WebCodecs, wasm cuma cadangan

Di browser, PWA, dan APK, konversi dikerjakan lewat **WebCodecs**: decode dan
encode diserahkan ke mesin media milik perangkat — chip yang sama yang dipakai
browser untuk memutar video. ffmpeg.wasm tetap ada, tapi hanya sebagai cadangan.

Angka terukur (sumber 1080p60 HEVC, 46 detik, ke 720x1280/30, mesin yang sama):

| Jalur | Waktu | Catatan |
| --- | --- | --- |
| ffmpeg.wasm | ~6 menit (ekstrapolasi 78 dtk untuk 10 dtk klip) | H.264 software, satu thread |
| WebCodecs | 20 detik | setara FFmpeg native di mesin ini |
| FFmpeg native (Electron) | 14,5 detik | `-hwaccel auto` + libx264 |

Potong-tanpa-encode-ulang juga pindah ke jalur ini: 70 detik sumber jadi 3
bagian dalam **75 ms**, karena tidak ada satu pun frame yang di-decode.

Yang perlu diketahui saat membaca kodenya:

- `src/lib/webcodecs/pipeline.ts` — decode → canvas (framing 9:16) → encode →
  mux, semuanya lewat [mediabunny](https://mediabunny.dev). Tiap bagian adalah
  `Output` tersendiri, jadi frame pertamanya otomatis keyframe dan filenya bisa
  diputar sendiri, tanpa perlu `-force_key_frames` + segment muxer.
- Jalannya di **web worker** (`worker.ts`): encode hardware pun tetap menggambar
  tiap frame ke canvas, dan itu cukup berat untuk membuat UI tersendat.
- Bundle mediabunny (~536 kB) hanya masuk ke chunk worker. Browser tanpa
  WebCodecs tidak mengunduhnya, dan browser dengan WebCodecs tidak pernah
  mengunduh core wasm 32 MB — termasuk untuk baca metadata, yang sekarang
  selesai dalam ~13 ms.
- **CRF tidak ada di encoder hardware.** Ia hanya menerima target bitrate, jadi
  mode "Target ukuran" memakai bitrate dari planner apa adanya: hasilnya
  konsisten mendarat di target (mis. 14,7 MB untuk target 15 MB), sementara
  jalur FFmpeg dengan capped-CRF sering jauh di bawah target kalau isinya
  ringan. Mode "Kualitas (CRF)" tetap memberi file kecil, lewat heuristik
  bitrate yang sama yang dipakai estimasi di panel. Knob "Kecepatan encode"
  (preset x264) disembunyikan di jalur ini karena tidak ada efeknya.
- Sumber yang codec-nya tidak bisa di-decode hardware, atau kegagalan apa pun
  **sebelum frame pertama**, jatuh otomatis ke ffmpeg.wasm. Kegagalan di
  tengah jalan sengaja dimunculkan sebagai error, bukan diam-diam diulang di
  mesin yang 17x lebih lambat.

## SEO dan kartu share

Aplikasinya di-render di klien, jadi crawler yang tidak menjalankan JavaScript
akan melihat dokumen kosong. Yang dipasang untuk menutup itu:

- `index.html` — title + description yang memuat kata yang benar-benar dicari
  orang, canonical absolut, Open Graph + Twitter card, dan `robots` dengan
  `max-image-preview:large` supaya kartunya tampil lebar di hasil pencarian.
- **JSON-LD** (`WebApplication` + `MobileApplication`). Nomor versi dan ukuran
  APK-nya **tidak diketik tangan**: `vite.config.ts` menyuntiknya dari
  `src/apk-release.json` saat build, sumber yang sama dengan tombol unduh.
- `<noscript>` berisi klaim yang sama dalam HTML biasa, untuk klien tanpa JS.
- `public/robots.txt` + `public/sitemap.xml`. `/assets/` sengaja **tidak**
  diblokir — Google butuh bundle dan stylesheet untuk me-render aplikasi klien;
  yang diblokir hanya `/ffmpeg/` (core wasm 32 MB) dan `/downloads/` (APK).
- `public/og.png` (1200x630) dibuat ulang lewat
  [`scripts/make-og-image.mjs`](scripts/make-og-image.mjs), dikomposisi dengan
  binary FFmpeg yang sudah dipakai build desktop — jadi tidak ada dependensi
  baru untuk aset yang berubah setahun sekali.

Semua URL absolut di head sengaja hard-code ke `https://wastatus.emha.space`:
crawler me-resolve-nya terhadap salinannya sendiri, bukan terhadap
`document.baseURI` yang di build ini relatif (`base: './'`). Build Electron dan
Capacitor ikut membawa tag itu, di sana tidak ada efeknya.

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
  lib/ffmpegClient.ts load core, ffprobe, segment muxer, progress, auto-retry
  lib/webcodecs/      mesin hardware: pipeline (decode/canvas/encode/mux),
                      worker, dan klien di UI thread
  components/         Dropzone, Preview (safe zone), Panel, Result
  components/icons.tsx  ikon SVG inline (tanpa dependensi, tanpa emoji)
  lib/engine.ts       pemilih backend: native (Electron) > WebCodecs > wasm
electron/
  main.ts             jendela, spawn FFmpeg native, progress
  ffmpeg.ts           orkestrasi native: hwaccel decode, segment muxer, retry
  preload.ts          jembatan IPC minimal (window.waNative)
```

## Catatan performa

Sejak WebCodecs masuk, ffmpeg.wasm hanya kena kalau browsernya tidak punya
WebCodecs atau codec sumbernya tidak bisa di-decode hardware. Angkanya ada di
tabel di atas.

Di sisi desktop, decode dipindah ke GPU lewat `-hwaccel auto` (lihat
`electron/ffmpeg.ts`). Encode tetap libx264, jadi tidak ada satu piksel pun yang
berubah — hanya waktunya: 19,8 → 14,5 detik pada sumber 1080p60 HEVC. Encoder
hardware (`h264_qsv`/`nvenc`/`amf`) sengaja **tidak** dipakai di sini: ia turun
ke ~10 detik, tapi menukar capped-CRF dengan ABR, dan di desktop jaminan "selalu
di bawah 16 MB dengan kualitas seadanya isi" lebih berharga daripada 4 detik.

Kalau jalur wasm yang kepakai, default 720x1280 memangkas waktu kira-kira
setengah dibanding 1080x1920 (2.25x lebih sedikit piksel). Untuk lebih cepat
lagi, pakai mode CRF atau preset `Cepat` di panel.

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
