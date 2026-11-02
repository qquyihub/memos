# Memos on Cloudflare

将 [Memos](https://github.com/usememos/memos) 笔记应用完整迁移到 Cloudflare 边缘平台，使用 Workers + D1 替代原有的 Go + SQLite + 本地存储架构；R2 / KV 为可选资源，默认仅使用 D1。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1 (SQLite) |
| 文件存储 | Cloudflare R2（可选）/ S3 / WebDAV |
| AI | Cloudflare Workers AI (Whisper) |
| 前端 | React + Vite + TailwindCSS |
| 认证 | JWT (HS256) + bcrypt |

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 4.14
- Cloudflare 账号（已开通 Workers、D1；R2 / KV 可选）

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
npm run cf:setup    # 查找或创建 D1（按需创建 R2 / KV），生成 wrangler.local.toml
npm run cf:init     # 对远程 D1 应用 migrations
npm run cf:deploy   # 构建前端 + 迁移 + 写入 JWT_SECRET + 部署
```

`npm run cf:deploy` 是完整自动化路径：`setup → build → init → deploy`。
`npm run deploy` 只是原生的 `wrangler deploy`，要求 `web/dist` 已构建且 `wrangler.local.toml`（或环境变量/Secrets）已就绪。

脚本会：

- 默认只查找或创建 D1 数据库；R2 / KV 默认不创建、不绑定；
- 需要 R2 或 KV 时，设置 `CFMEMOS_ENABLE_R2=true` / `CFMEMOS_ENABLE_KV=true` 后再执行脚本；
- D1 / R2 / KV 的资源名称均可通过变量覆盖，默认都是 `memos`；
- 将真实资源 ID 只写入 Git 忽略的 `wrangler.local.toml`，不污染仓库；
- 优先使用 `JWT_SECRET` 环境变量，其次读取 `.dev.vars`，最后自动生成随机值并写入 `.dev.vars`；
- 仅在远程 Worker 尚无 `JWT_SECRET` 时写入 Secret，重复部署不会轮换密钥；
- 幂等，可反复执行。

可通过 `CFMEMOS_D1_NAME`、`CFMEMOS_R2_BUCKET`、`CFMEMOS_KV_NAME` 覆盖资源名称，三者默认都是 `memos`。

默认不启用 KV 与 R2，只需设置 `CFMEMOS_ENABLE_KV=true` 或 `CFMEMOS_ENABLE_R2=true` 即可开启；脚本会自动创建或复用对应资源，并把绑定写入 `wrangler.local.toml`。未启用 R2 时，附件存储可使用设置中的 S3 / WebDAV 后端。

### 方式二：Cloudflare 控制台导入 Git 仓库（推荐）

适合直接在 `https://dash.cloudflare.com/` 新建项目：

1. Fork 本仓库；
2. 进入 **Workers & Pages → Create application → Import a repository**，选择 Fork 与 `main`；
3. **Build settings**（两个命令必须分别填写，不要拼在一起）：
   - Root directory 留空；
   - Build command **留空**（部署命令会自行构建前端）；
   - Deploy command：`npm run cf:deploy`；
4. **API token**：不要使用 Cloudflare 自动生成的默认 Token。默认 Token 只包含 Workers Scripts / KV / R2 编辑权限，**不包含 D1 权限**，无法自动创建或绑定 D1。请先在 **My Profile → API Tokens → Create Token** 创建自定义 Token，至少包含：
   - Account → **Workers Scripts: Edit**
   - Account → **D1: Edit**
   - Account → **Workers R2 Storage: Edit**（仅启用 R2 时需要）
   - Account → **Workers KV Storage: Edit**（仅启用 KV 时需要）

   然后在 Build settings 的 **API token** 中选择该 Token；如需启用 R2 / KV，在 Build settings 中添加环境变量 `CFMEMOS_ENABLE_R2=true` / `CFMEMOS_ENABLE_KV=true`（也可用 `CFMEMOS_D1_NAME`、`CFMEMOS_R2_BUCKET`、`CFMEMOS_KV_NAME` 改名）；
5. 保存并部署。`npm run cf:deploy` 会自动完成：构建前端生成 `web/dist` → 查找或创建 D1 `memos`（启用 R2 / KV 时同时创建对应资源，默认名称均为 `memos`）→ 生成 `wrangler.local.toml` → 执行 D1 migrations → 首次部署时写入 `JWT_SECRET` → 部署 Worker；
6. 部署完成后访问 Workers URL，首次访问会进入管理员注册页面。

> 也可拆分为两步：Build command 填 `npm run build`，Deploy command 填 `npm run cf:deploy -- --skip-build`。
>
> 如果 Deploy command 使用 Cloudflare 默认的 `npx wrangler deploy`：同样必须配置上面的自定义 API Token（否则 D1 自动供给会因缺少权限失败），并且必须在 Build command 填 `npm run build`（否则报 `assets.directory` 不存在）。默认命令不会执行数据库迁移，需要在首次部署后于本地仓库运行一次 `npm install && npm run cf:init`（需先 `npx wrangler login`）。

### 方式三：手动创建资源

```bash
# 创建 D1 数据库（默认名称 memos）
npx wrangler d1 create memos

# 可选：启用 R2 时创建存储桶
npx wrangler r2 bucket create memos

# 按名称找到上述资源，生成包含真实资源 ID 的 wrangler.local.toml
# 启用 R2 / KV 时先设置 CFMEMOS_ENABLE_R2=true / CFMEMOS_ENABLE_KV=true
npm run cf:setup

# 初始化数据库
npm run cf:init

# 构建并部署（会自动生成并写入 JWT_SECRET）
npm run cf:deploy
```

## GitHub Actions 自动部署

推送到 `main` 分支会自动触发部署。需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret / Variable | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers Scripts:Edit、D1:Edit；启用 R2 / KV 时还需要对应权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（在 Dashboard 右侧栏可找到） |
| `JWT_SECRET` | 可选。首次部署时写入；未配置时脚本会自动生成 |
| `CFMEMOS_ENABLE_R2` | 可选 Variable。设为 `true` 时创建/绑定 R2，默认关闭 |
| `CFMEMOS_ENABLE_KV` | 可选 Variable。设为 `true` 时创建/绑定 KV，默认关闭 |
| `CFMEMOS_D1_NAME` | 可选 Variable。D1 数据库名称，默认 `memos` |
| `CFMEMOS_R2_BUCKET` | 可选 Variable。R2 存储桶名称，默认 `memos` |
| `CFMEMOS_KV_NAME` | 可选 Variable。KV 命名空间名称，默认 `memos` |

工作流会自动完成：安装依赖 → 构建前端 → 创建或复用 D1（按需创建 R2 / KV）→ 生成 `wrangler.local.toml` → 执行数据库迁移 → 写入 `JWT_SECRET` → 部署 Worker。


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
├── wrangler.toml          # Cloudflare 配置（默认仅 D1 + AI，R2 / KV 由变量开启）
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
| `CFMEMOS_ENABLE_R2` | 设为 `true` / `1` 时创建并绑定 R2，默认关闭 | 否 |
| `CFMEMOS_ENABLE_KV` | 设为 `true` / `1` 时创建并绑定 KV，默认关闭 | 否 |
| `CFMEMOS_D1_NAME` | 自动创建/查找的 D1 数据库名称，默认 `memos` | 否 |
| `CFMEMOS_R2_BUCKET` | 启用 R2 后自动创建/查找的存储桶名称，默认 `memos` | 否 |
| `CFMEMOS_KV_NAME` | 启用 KV 后自动创建/查找的命名空间名称，默认 `memos` | 否 |

生产环境通过 `wrangler secret put` 设置敏感变量，非敏感变量在 `wrangler.toml` 的 `[vars]` 中配置。

## Cloudflare 资源绑定

| 绑定名 | 类型 | 用途 |
|--------|------|------|
| `DB` | D1 Database | 必选。存储用户、备忘录、设置等所有结构化数据 |
| `BUCKET` | R2 Bucket（可选） | 存储附件文件（图片、音频、文档）；默认不绑定，`CFMEMOS_ENABLE_R2=true` 时启用 |
| `CACHE` | KV Namespace（可选） | 缓存实例统计、用户统计与链接元数据；默认不绑定，`CFMEMOS_ENABLE_KV=true` 时启用 |
| `AI` | Workers AI | 音频转写（@cf/openai/whisper） |
| `ASSETS` | Static Assets | 托管前端构建产物 |

未启用 R2 时，附件上传可通过实例设置中的 S3 / WebDAV 存储后端完成；两者都未配置时上传附件会返回错误，其他功能不受影响。

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

确认 `npm run build` 已执行且 `web/dist/` 目录存在。`wrangler deploy` 会自动上传该目录。

**Q: 在 Dashboard 部署时报无权限创建 D1 数据库？**

Workers Builds 自动生成的 API Token 不包含 D1 权限。按“方式二”第 4 步创建包含 **D1: Edit** 的自定义 Token，并在 **Settings → Build → API token** 中选择它即可。

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
wrangler d1 export memos --remote --output=backup.sql

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
