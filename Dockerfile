# wa-status ships PREBUILT: `dist/` is produced on the dev machine or CI runner
# (`npm run build`), never on the VPS. The box has ~600Mi RAM free and a vite +
# tsc build there risks OOM-killing the neighbouring estate containers.
FROM caddy:2-alpine

COPY Caddyfile.container /etc/caddy/Caddyfile
COPY dist /srv

EXPOSE 8080
