FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /opt/mobile
COPY server.mjs status.js status.html ./
COPY tnas/catalog.mjs tnas/site.mjs ./tnas/
USER node
CMD ["node","tnas/site.mjs"]
