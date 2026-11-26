# Built with context ./services so the image can copy shared/ without parent-path COPY.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/partner-gateway
COPY partner-gateway/package.json partner-gateway/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared /app/services/shared
COPY partner-gateway/index.js ./
USER node
EXPOSE 8003
CMD ["node", "index.js"]
