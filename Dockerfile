FROM node:24-alpine
WORKDIR /srv/anysys
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY signaling/ ./signaling/
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
USER node
CMD ["node", "signaling/server.cjs"]
