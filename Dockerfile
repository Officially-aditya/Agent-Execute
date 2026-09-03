FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests ./tests
COPY tsconfig.json ./
RUN npm install --no-audit --no-fund
RUN npm run typecheck
EXPOSE 3001 3002
CMD ["npm","run","dev:agent"]
