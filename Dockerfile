FROM node:20-bookworm-slim

# 安装 Chromium、Firefox 依赖、虚拟显示、字体与软件渲染的 OpenGL 支持
# libgl*/libgl1-mesa-dri：Xvfb 里没有 GPU，靠 Mesa llvmpipe 提供 WebGL。
#   Epic 登录页的风控会采集 WebGL，缺了它会被判成异常浏览器。
# fontconfig + 各字体包：--no-install-recommends 不会自动装推荐项，
#   字体缺失会让页面回退到占位字形，出现满屏乱码。
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-wqy-zenhei \
    libgl1 \
    libegl1 \
    libgles2 \
    libglx-mesa0 \
    libgl1-mesa-dri \
    tzdata \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV EPIC_VISIBLE=1
ENV DISPLAY=:1
# 容器内没有 GPU，固定走 Mesa 软件渲染，避免 Firefox 尝试 DRI 失败后直接禁用 WebGL。
ENV LIBGL_ALWAYS_SOFTWARE=1

WORKDIR /app

# 先复制 package 文件以利用 Docker 层缓存
COPY package*.json ./

# 有 package-lock.json 时用 npm ci，构建结果可复现（不会因为依赖漂移导致线上行为变化）
RUN npm ci --omit=dev

# Playwright Firefox 是 Epic 专用引擎；同时安装 Firefox 运行依赖。
RUN npx playwright install --with-deps firefox

# 复制源码与资源
COPY src/ ./src/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 创建持久化数据目录
RUN mkdir -p /app/data

EXPOSE 5308 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5308/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

VOLUME ["/app/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
