# Built with context ./services so the image can copy shared/ without parent-path COPY.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/wallet-transfer
COPY wallet-transfer/package.json wallet-transfer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared /app/services/shared
COPY wallet-transfer/index.js ./
USER node
EXPOSE 8002
CMD ["node", "index.js"]
