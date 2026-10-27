FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY app app
COPY data data
RUN mkdir logs && chown node:node logs

USER node
EXPOSE 8000
CMD ["node", "--import", "tsx", "app/cli/serve.ts"]
