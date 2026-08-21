# wa-status ships PREBUILT: `dist/` is produced on the dev machine or CI runner
# (`npm run build`), never on the VPS. The box has ~600Mi RAM free and a vite +
# tsc build there risks OOM-killing the neighbouring estate containers.
FROM caddy:2-alpine

COPY Caddyfile.container /etc/caddy/Caddyfile
COPY dist /srv

# Precompress once at build time instead of gzipping on every request: the
# ffmpeg core alone is 32MB (~1.1s of VPS CPU per uncached hit). Caddy serves
# these .gz sidecars via `precompressed gzip`, so serving costs nothing.
RUN find /srv -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.css' -o -name '*.html' \) \
      -size +1k -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \; \
 && echo "precompressed:" && find /srv -name '*.gz' -exec ls -lh {} \; | awk '{print $5, $9}'

EXPOSE 8080
