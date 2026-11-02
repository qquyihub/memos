# Memos on Cloudflare

将 [Memos](https://github.com/usememos/memos) 笔记应用完整迁移到 Cloudflare 边缘平台，使用 Workers + D1 + R2 替代原有的 Go + SQLite + 本地存储架构。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1 (SQLite) |
| 文件存储 | Cloudflare R2 |
| AI | Cloudflare Workers AI (Whisper) |
| 前端 | React + Vite + TailwindCSS |
| 认证 | JWT (HS256) + bcrypt |

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 4.14
- Cloudflare 账号（已开通 Workers、D1、R2）

## 快速部署

### 方式一：一键自动创建、绑定、初始化（推荐）

前置要求：Node.js >= 18，并已完成 Cloudflare 认证：

```bash
npx wrangler login
# 或在 CI 中设置 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID
```

```bash
git clone https://github.com/jkjoy/memos-on-cloudflare.git
cd memos-on-cloudflare

npm install
cd web && npm install && cd ..

npm run cf:doctor   # 检查账号、资源与配置
npm run cf:setup    # 查找或创建 D1 / R2，生成 wrangler.local.toml
npm run cf:init     # 对远程 D1 应用 migrations
npm run cf:deploy   # 构建前端 + 迁移 + 写入 JWT_SECRET + 部署
```

`npm run deploy` 等价于一次执行 `setup → build → init → deploy`。

脚本会：

- 按名称 `cfmemos-db` 与 `memos` 查找 D1 / R2；不存在时自动创建，已存在时复用；
- 将真实资源 ID 只写入 Git 忽略的 `wrangler.local.toml`，不污染仓库；
- 优先使用 `JWT_SECRET` 环境变量，其次读取 `.dev.vars`，最后自动生成随机值并写入 `.dev.vars`；
- 仅在远程 Worker 尚无 `JWT_SECRET` 时写入 Secret，重复部署不会轮换密钥；
- 幂等，可反复执行。

可通过 `CFMEMOS_D1_NAME`、`CFMEMOS_R2_BUCKET` 覆盖资源名称。

### 方式二：Cloudflare 控制台导入 Git 仓库

适合在 Cloudflare 上直接新建项目：

1. Fork 本仓库；
2. 进入 **Workers & Pages → Create application → Import a repository**，选择 Fork；
3. Production branch 选择 `main`，Root directory 留空，Build command 填写 `npm install && cd web && npm install && npm run build`，Deploy command 填写 `node scripts/cloudflare-deploy.mjs deploy --skip-build`；
4. 确认 Cloudflare 构建使用的 API Token 具备 **D1:Edit** 与 **R2:Edit** 权限。脚本会据此自动创建并绑定 `DB`、`BUCKET`；
5. 在 Worker 的 **Settings → Variables and Secrets** 中确认存在 `JWT_SECRET`（脚本会自动生成，也可自行指定强随机值）；
6. 部署完成后访问 Workers URL，首次访问会进入管理员注册页面。

> 如果保留 Cloudflare 默认的 Deploy command `npx wrangler deploy`，Cloudflare 会依据 `wrangler.toml` 中无 ID 的声明自动创建并绑定 D1 / R2，但不会执行数据库迁移。此时需要在首次部署后额外运行一次 `npm run cf:init`（或使用方式三）。

### 方式三：手动创建资源

```bash
# 创建 D1 数据库
npx wrangler d1 create cfmemos-db

# 创建 R2 存储桶
npx wrangler r2 bucket create memos

# 按名称找到上述资源，生成包含真实资源 ID 的 wrangler.local.toml
npm run cf:setup

# 初始化数据库
npm run cf:init

# 构建并部署（会自动生成并写入 JWT_SECRET）
npm run cf:deploy
```

## GitHub Actions 自动部署

推送到 `main` 分支会自动触发部署。需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers Scripts:Edit、D1:Edit、R2:Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（在 Dashboard 右侧栏可找到） |
| `JWT_SECRET` | 可选。首次部署时写入；未配置时脚本会自动生成 |

工作流会自动完成：安装依赖 → 构建前端 → 创建或复用 D1/R2 → 生成 `wrangler.local.toml` → 执行数据库迁移 → 写入 `JWT_SECRET` → 部署 Worker。


## 本地开发

需要两个终端窗口：

```bash
# 终端 1：启动 Worker 后端（端口 8787）
npm run db:migrate   # 首次运行需要初始化本地数据库
npm run dev

# 终端 2：启动前端开发服务器（端口 3001，自动代理 API 到 8787）
npm run dev:web
```

浏览器访问 `http://localhost:3001`。

## 项目结构

```
├── wrangler.toml          # Cloudflare 配置（D1、R2、AI 绑定，不含真实资源 ID）
├── package.json           # 根 package，部署脚本
├── scripts/
│   └── cloudflare-deploy.mjs  # 自动创建/绑定/初始化/部署
├── migrations/
│   └── 0001_initial.sql   # D1 数据库 schema
├── worker/
│   └── src/
│       ├── index.ts       # Hono 入口，路由挂载
│       ├── types.ts       # Env 绑定类型定义
│       ├── routes/        # API 路由
│       │   ├── auth.ts    # 登录/注册/刷新令牌
│       │   ├── memos.ts   # 备忘录 CRUD + 评论/反应/分享
│       │   ├── users.ts   # 用户管理 + 设置/PAT/通知
│       │   ├── attachments.ts  # 文件上传（R2）
│       │   ├── files.ts   # 文件下载服务
│       │   ├── instance.ts # 实例配置
│       │   ├── ai.ts      # Workers AI 转写
│       │   ├── idp.ts     # SSO 身份提供商
│       │   ├── shortcuts.ts # 快捷过滤器
│       │   └── sse.ts     # 实时更新
│       ├── auth/          # JWT、密码哈希、PAT
│       ├── db/            # D1 查询模块
│       └── middleware/    # 认证中间件
└── web/
    └── src/
        ├── connect.ts     # REST 客户端（替代 Connect RPC）
        ├── contexts/      # React Context（实例、认证）
        ├── components/    # UI 组件
        ├── pages/         # 页面路由
        ├── locales/       # i18n 翻译文件
        └── shims/         # @bufbuild/protobuf 兼容层
```

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥；未设置时 `cf:deploy` 会自动生成 | 是 |
| `INSTANCE_NAME` | 实例名称，显示在页面标题 | 否 |
| `CFMEMOS_D1_NAME` | 自动创建/查找的 D1 数据库名称，默认 `cfmemos-db` | 否 |
| `CFMEMOS_R2_BUCKET` | 自动创建/查找的 R2 存储桶名称，默认 `memos` | 否 |

生产环境通过 `wrangler secret put` 设置敏感变量，非敏感变量在 `wrangler.toml` 的 `[vars]` 中配置。

## Cloudflare 资源绑定

| 绑定名 | 类型 | 用途 |
|--------|------|------|
| `DB` | D1 Database | 存储用户、备忘录、设置等所有结构化数据 |
| `BUCKET` | R2 Bucket | 存储附件文件（图片、音频、文档） |
| `AI` | Workers AI | 音频转写（@cf/openai/whisper） |
| `ASSETS` | Static Assets | 托管前端构建产物 |

## 自定义域名

在 Cloudflare Dashboard 中为 Worker 添加自定义域名：

1. Workers & Pages → cfmemos → Settings → Domains & Routes
2. 添加自定义域名（需要域名已在 Cloudflare DNS 中）

## 功能特性

- Markdown 备忘录（支持标签、代码块、任务列表、Mermaid 图表）
- 多用户支持（管理员/普通用户）
- 备忘录可见性（私有/工作区/公开）
- 文件附件上传（最大 100MB）
- 备忘录分享链接（可设过期时间）
- 备忘录评论和表情反应
- 音频录制 + AI 转写
- SSO 单点登录
- 多语言支持（中文、英文等 30+ 语言）
- 暗色/亮色主题
- 日历热力图
- 标签管理
- Webhook 通知

## 与原版 Memos 的区别

| 项目 | 原版 Memos | 本项目 |
|------|-----------|--------|
| 后端 | Go + gRPC | Cloudflare Workers + Hono |
| 数据库 | SQLite (本地文件) | Cloudflare D1 (托管 SQLite) |
| 文件存储 | 本地/S3 | Cloudflare R2 |
| AI | OpenAI/Gemini API | Cloudflare Workers AI |
| 部署 | Docker/二进制 | `wrangler deploy` |
| 运维 | 需要服务器 | 无服务器，零运维 |
| 前端通信 | Connect RPC (protobuf) | REST JSON |

## 常见问题

**Q: 部署后访问显示空白页？**

确认 `npm run build:web` 已执行且 `web/dist/` 目录存在。`wrangler deploy` 会自动上传该目录。

**Q: 访问 `/api/*` 返回前端 404 页面？**

确认 `wrangler.toml` 的 `[assets]` 配置包含：

```toml
run_worker_first = ["/api/*", "/file/*", "/u/*"]
```

否则 Cloudflare 静态资源层可能会先处理请求，并把不存在的 API 路径回退到 SPA 的 `index.html`，最终显示前端 404 页面，而不是进入 Worker API 路由。

**Q: 数据库报错 "table not found"？**

执行 `npm run db:migrate:remote` 初始化远程数据库 schema。

**Q: 如何备份数据？**

```bash
# 导出 D1 数据库
wrangler d1 export cfmemos-db --remote --output=backup.sql

# R2 文件可通过 rclone 或 Cloudflare Dashboard 下载
```

**Q: 上传大小限制？**

附件上传硬编码为 100MB。Workers 免费版单次请求体限制为 100MB，付费版无此限制。

**Q: 免费额度够用吗？**

Cloudflare Workers Free Plan 包含：每天 10 万次请求、D1 5GB 存储、R2 10GB 存储 + 每月 1000 万次读取。个人使用完全足够。

## Star History

<a href="https://www.star-history.com/?repos=jkjoy%2Fmemos-on-cloudflare&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=jkjoy/memos-on-cloudflare&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=jkjoy/memos-on-cloudflare&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=jkjoy/memos-on-cloudflare&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT

</content>
</invoke>
