FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
COPY docs/SCHEMA.sql ./docs/SCHEMA.sql
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
ENV MINIOFFICE_HOST=0.0.0.0
EXPOSE 3000
CMD ["bun", "src/index.ts"]
