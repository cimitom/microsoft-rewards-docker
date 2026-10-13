# 🎁 Microsoft Rewards 微软积分全能自动化助手 (Docker / WebUI 版)

> 🌟 **无需电脑保持开机与浏览器常驻！专为 NAS（群晖、威联通、极空间、绿联等）与 VPS 打造的微软 Rewards 每日任务全自动签到托管系统。**  
> 配备全新**现代化深色 Fluent 毛玻璃控制台**、**小白一键可视化配置向导**、**HTTP/SOCKS5 代理支持**、**国区防风控锁**与**多渠道消息推送**。

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)
[![Version](https://img.shields.io/badge/Version-v1.3.0-blue.svg)](https://github.com/wangheqiang530/microsoft-rewards-docker)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

---

## ✨ 核心特性

- 👥 **多账号矩阵管理与一键切换 (全新 v1.2.0)**：
  - 支持绑定并同时托管多个微软账户，各账号独立 Cookie / Token，环境彻底隔离；
  - 顶部一键切换胶囊：支持 **「全部账号汇总大屏」** 与 **「单账号深度看板」** 自由穿梭；
  - 顺序轮询巡检打卡，账号间内置 **安全随机防风控间隔**，防止关联风控。
- 🖥️ **完全脱离电脑与浏览器**：基于轻量 Docker 容器后台静默常驻，7×24 小时自动巡检。
- 📊 **现代化 Fluent 毛玻璃 Web 控制台**：
  - 五核 Hero 指标大屏：今日已增积分、当前总积分、今日任务达成率、连续签到天数、连签印章进度 (8/12)；
  - 任务进度微光进度条与打卡状态可视化；
  - 距离每日刷新剩余时间动态秒级倒计时；
  - 实时执行流时间轴与内置终端风格彩色日志流（支持 SSE 实时推流滚屏）；
  - **📈 每日积分历史趋势看板**：支持 **7 日** 与 **30 日** 动态切换，鼠标悬停柱子浮现详细打卡明细与结余积分；
  - **🌓 日夜模式与跟随系统**：支持一键切换日间模式、夜间模式或跟随操作系统。
- 💡 **小白 1 分钟极简配置向导**：无需懂代码，通过 Web 页面指引点击一键授权微软登录、粘贴 Cookie，系统自动换取 Token 并永久自动续期。
- 🌐 **网络环境与代理（防风控关键）**：
  - 支持配置 **HTTP / HTTPS / SOCKS5 代理**；
  - 支持 **一键测试出口 IP 与地理位置**；
  - **默认锁定中国大陆 IP**：若当前出口为境外 IP 自动阻断打卡，彻底避免国外 VPS 导致被微软风控锁区或封号。
- 📱 **全任务自动化支持（包含独家逆向）**：
  - 📱 **移动端 App 签到**：模拟 BingSapphire 安卓客户端静默签到；
  - 💻 **PC 网页端签入**：连签自动累加；
  - 📖 **新闻资讯自动阅读**：每日自动通过 DAPI 阅读 10 篇资讯（满额 +30 积分）；
  - 🔍 **必应 PC 搜索任务**：智能随机延时 + 本地离线词库 / 3大百度热搜榜单轮询，安全打满 60 分；
  - 📅 **每日活动集 (Daily Set)**：Next.js Server Action 自动完成 3/3 连签活动；
  - 🧩 **活动卡片与 Quiz 趣味问答**：自动答题与卡片二次扫描；
  - 🖥️ **桌面客户端专属任务**：伪装官方桌面客户端特征，每周全自动拿满 70 分打孔卡（支持动态到期天数与 3/8 进度呈现）；
  - 🔥 **连签保持与视觉搜索**：自动补签维持最高连签纪录。
- 🔔 **多渠道消息通知**：支持 **Telegram Bot (TG推送)**、企业微信机器人、钉钉机器人、飞书机器人、Bark、PushMe 等，支持一键发送测试消息。

---

## 📋 任务支持清单与积分对应

| 任务类型 | 支持状态 | 对应积分 | 进度可视化 | 说明 |
| :--- | :---: | :---: | :---: | :--- |
| **PC 签入** | ✅ 已支持 | +10 ~ 20 积分 | 1/1 次 (100%) | 根据连签天数阶梯递增 |
| **移动端 App 签入** | ✅ 已支持 | +10 ~ 50 积分 | 1/1 次 (100%) | 模拟真实安卓客户端静默提交 |
| **新闻资讯阅读** | ✅ 已支持 | +30 积分/天 | 30/30 篇 (100%) | 每日自动阅读 10 篇新闻 |
| **必应 PC 搜索** | ✅ 已支持 | +60 积分/天 | 60/60 分 (100%) | 智能随机延时防风控检索 |
| **日常活动集 (Daily Set)** | ✅ 已支持 | +30 ~ 50 积分/天 | 3/3 个 (100%) | 每日 3 个日常活动（Quiz / 投票 / 打卡） |
| **桌面应用每周专属任务** | ✅ 独家支持 | +70 积分/周 | 8 天打孔卡进度 | 伪装桌面客户端专属解锁打卡 |
| **连签检测与视觉搜索打卡** | ✅ 已支持 | 维持连签纪录 | 连续打卡天数 | 自动打卡维持最高天数纪录 |

---

## 🚀 极速部署指南

### 方法 1：使用 Docker Compose 部署（推荐，群晖/威联通/极空间/VPS）

1. 在服务器或 NAS 上创建一个项目目录，例如 `ms-rewards`：
```bash
mkdir -p ms-rewards && cd ms-rewards
```

2. 在该目录下创建 `docker-compose.yml` 文件：
```yaml
version: '3.8'

services:
  microsoft-rewards:
    image: wangheqiang/microsoft-rewards-docker:latest
    # 或者使用 GitHub 镜像：
    # image: ghcr.io/wangheqiang530/microsoft-rewards-docker:latest
    container_name: ms-rewards
    restart: unless-stopped
    ports:
      - "5308:5308"
    environment:
      - TZ=Asia/Shanghai
      - PORT=5308
    volumes:
      - ./data:/app/data
```

3. 启动容器：
```bash
docker compose up -d
```

4. 启动后，打开浏览器访问：`http://<NAS或VPS的IP>:5308`，即可进入现代化控制台！

---

### 方法 2：使用 Docker Run 命令行单行启动

```bash
docker run -d \
  --name ms-rewards \
  --restart unless-stopped \
  -p 5308:5308 \
  -v $(pwd)/data:/app/data \
  -e TZ=Asia/Shanghai \
  wangheqiang/microsoft-rewards-docker:latest
```

---

### 方法 3：本地源码运行与开发

```bash
# 1. 克隆代码仓库
git clone https://github.com/wangheqiang530/microsoft-rewards-docker.git
cd microsoft-rewards-docker

# 2. 安装依赖
npm install

# 3. 启动服务
npm start
```

服务启动后，浏览器访问 `http://localhost:5308`。

---

## 📁 数据持久化与文件说明

容器内 `/app/data` 目录通过 Volume 挂载到宿主机本地的 `./data` 目录，所有关键数据均已完整暴露并持久化存储，无需进入容器内部即可直接在 NAS 文件管理套件或宿主机中查看、修改或迁移备份：

| 文件路径 | 用途说明 |
| :--- | :--- |
| `data/config.json` | **核心配置文件**（包含微软凭据 Cookie/Token、代理配置、任务开关、通知渠道等） |
| `data/app.log` | **持久化运行日志文件**（实时记录后台自动打卡细节、接口请求与排查日志） |
| `data/stats.json` | **任务状态快照**（记录当日积分、任务配额进度与连签天数） |
| `data/history.json` | **历史积分账单数据**（用于前端 7 日 / 30 日历史趋势柱状图明细展示） |

---

## 💡 小白 1 分钟配置上手指南

初次打开 Web 控制台时，点击右上角的 **「💡 新手配置向导」**，跟随引导仅需 3 步：

### 步骤 1：移动端授权 (OAuth Token)
1. 点击向导中的 **「🔑 打开微软官方登录授权页」**，在弹出的微软官网登录你的账号；
2. 登录同意后，浏览器会跳转至类似 `https://login.live.com/oauth20_desktop.srf?code=M.C508_...` 的地址；
3. 将地址栏中的完整 URL 复制粘贴到输入框中，点击 **「一键换取并保存 Token」**。
> ✨ 提示：系统会自动捕获并持久化保存 Refresh Token，后续系统会**永久自动无感续期**，无需再次操作。

### 步骤 2：网页端 Cookie 配置
1. 在电脑浏览器登录 [rewards.bing.com](https://rewards.bing.com)；
2. 按 `F12` 打开开发者工具，在【网络 / Network】中抓取任意请求的 `Cookie`，或者直接在【应用程序 / Application -> Cookies】中复制完整 Cookie 文本；
3. 粘贴至输入框，点击 **「测试 Cookie 有效性」**，确认显示“Cookie 有效”即可。

### 步骤 3：网络与代理（若在境外 VPS 部署必选）
- 如果你的设备在**中国国内家庭宽带 / NAS**：保持默认直连即可。
- 如果你的设备在**境外 VPS**：
  1. 勾选 **「启用网络代理」**；
  2. 填写国内代理节点地址（如 `http://x.x.x.x:7890` 或 `socks5://x.x.x.x:1080`）；
  3. 点击 **「一键检测出口 IP 与地区」**，确认出口归属为 **中国大陆 (CN)**，防止因海外 IP 导致微软账号被锁区或异常。

配置完成后，点击 **「▶️ 立即执行」**，即可在控制台实时看到打卡日志与积分上涨！

---

## ⚙️ 进阶配置与高级功能

点击右上角 **「⚙️ 配置中心」** 可进行详细参数微调：

- **任务开关**：可单独开启/关闭签到、新闻阅读、PC 搜索、活动卡片、桌面专属任务；
- **防风控间隔**：搜索基准延时默认为 30 秒（内置随机浮动），支持自定义搜索词源（离线词库或热搜 API）；
- **定时巡检调度**：
  - 默认 Cron：`*/25 * * * *`（每 25 分钟后台巡检一次）；
  - 支持自定义，如 `0 8,12,20 * * *`（每天 8 点、12 点、20 点执行）；
- **消息推送**：
  - 支持配置企业微信、钉钉（关键词需带 `#`）、飞书、Bark、PushMe，面板提供一键发送测试消息。

---

## ❓ 常见问题 (FAQ)

### Q1：为什么提示“非中国大陆 IP，已自动停止”？
**答**：微软 Rewards 会严格检测用户 IP 地区。如果是中国区账号但在境外 IP 上打卡，极易被微软风控（封号、无法兑换礼品卡、任务跳区）。为保护您的账号安全，程序默认启用了国区安全锁。境外 VPS 用户请在配置中心开启代理并走国内节点。

### Q2：网页端 Cookie 会过期吗？需要经常更新吗？
**答**：微软网页 Cookie 通常有效期长达数周至数月。移动端的 OAuth Token 则由程序通过 Refresh Token 自动在后台刷新续期，无需手动干预。若 Cookie 失效，控制台及推送通知会主动提示您重新抓取。

### Q3：如何备份我的配置数据？
**答**：所有配置文件、任务进度与统计历史均保存在映射的 `./data` 目录中（包括 `config.json` 和 `stats.json`）。更换设备时只需打包转移 `data` 目录即可实现无缝迁移。

---

## 📜 开源协议与致谢

- 本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源。
- 核心打卡业务逻辑参考并重构自 [微软积分（全能任务版）](https://scriptcat.org/zh-CN/script-show-page/8121) 油猴脚本，感谢原开源作者的基础逆向研究工作！
