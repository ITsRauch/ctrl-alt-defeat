FROM node:22-alpine
WORKDIR /app
# game files are owned by root and read-only for the runtime user
COPY server.js index.html README.md ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8091/api/highscores || exit 1
CMD ["node", "server.js", "8091"]
