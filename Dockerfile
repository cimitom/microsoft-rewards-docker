FROM node:20-alpine

# 安装 tzdata 确保时区正常
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app

# 先复制 package 文件以利用 Docker 层缓存
COPY package*.json ./

RUN npm install --omit=dev

# 复制源码与资源
COPY src/ ./src/

# 创建持久化数据目录
RUN mkdir -p /app/data

EXPOSE 5308

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:5308/api/status || exit 1

VOLUME ["/app/data"]

CMD ["npm", "start"]
