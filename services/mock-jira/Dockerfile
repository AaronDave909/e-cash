# Built with context ./services so the image can copy shared/ without parent-path COPY.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/mock-jira
COPY mock-jira/package.json mock-jira/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared /app/services/shared
COPY mock-jira/index.js ./
USER node
EXPOSE 8004
CMD ["node", "index.js"]
