FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY app app
COPY data data
COPY input_examples input_examples
RUN mkdir logs && chown node:node logs

USER node
EXPOSE 8000 8001
CMD ["node", "--import", "tsx", "app/cli/serve.ts"]
