FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl bash && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "server/hub.js"]
