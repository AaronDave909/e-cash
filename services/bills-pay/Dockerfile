# Built with context ./services so the image can copy shared/ without parent-path COPY.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/bills-pay
COPY bills-pay/package.json bills-pay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared /app/services/shared
COPY bills-pay/index.js ./
USER node
EXPOSE 8001
CMD ["node", "index.js"]
