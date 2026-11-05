# Memos on Cloudflare

将 [Memos](https://github.com/usememos/memos) 笔记应用迁移到 Cloudflare 边缘平台：使用 **Workers + D1** 替代上游的 Go + SQLite + 本地存储架构，前端使用 React + Vite，附件可存放在 R2、S3 兼容存储或 WebDAV。

当前功能基线对齐上游 **26.11.0**，并保留本项目自身的 Cloudflare 实现方式（REST API、D1、Workers AI）。

## 功能

- Markdown 备忘录：标签、代码块、任务列表、Mermaid 图表、附件与位置
- 备忘录可见性：私有 / 工作区 / 公开 / 空间
- 多用户与角色：管理员、普通用户
- **协作空间（Spaces）**：创建空间、成员角色、邀请 / 接受 / 拒绝 / 撤销邀请、空间内备忘录
- **保存的筛选视图（Memo Views）**：保存 CEL 风格过滤条件，随时打开复用
- **日历视图**与**备忘录地图**
- 备忘录评论、表情反应、分享链接
- 收件箱通知：评论、提及、空间邀请
- 文件上传：可配置单文件大小限制、图片预处理、可切换存储后端
- 音频录制与 Workers AI 转写（`@cf/openai/whisper`）
- SSO 身份提供商、个人访问令牌（PAT）、Webhook
- RSS（用户主页 / Explore）、SSE 实时刷新
- 30+ 语言、亮色 / 暗色主题

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1（SQLite） |
| 文件存储 | R2（可选）/ S3 兼容存储 / WebDAV |
| AI | Cloudflare Workers AI |
| 前端 | React 18 + Vite + Tailwind CSS 4 |
| 认证 | JWT（HS256）+ bcrypt + PAT |
| 通信 | REST JSON（替代上游 Connect RPC / protobuf） |

## 与上游 Memos 的差异

| 项目 | 上游 Memos | 本项目 |
|------|-----------|--------|
| 后端 | Go + gRPC / Connect | Cloudflare Workers + Hono REST |
| 数据库 | SQLite 文件 | Cloudflare D1 |
| 文件存储 | 本地 / S3 | R2 / S3 / WebDAV |
| AI | 可配置服务 | Workers AI 绑定 |
| 部署 | Docker / 二进制 | `wrangler deploy` |
| 运维 | 自托管服务器 | 无服务器，零运维 |
| 前端 | 上游完整编辑器与 AppSidebar | 本项目自有的编辑器与布局 |

## 前置要求

- Node.js >= 20
- Wrangler CLI >= 4.14
- Cloudflare 账号（Workers、D1；R2 / KV 可选）
- 如需通过 Dashboard 导入 Git 仓库部署，需要一个包含 **D1: Edit** 权限的 API Token

## 快速部署

### 方式一：脚本自动创建、绑定、初始化与部署（推荐）

```bash
git clone https://github.com/qquyihub/memos.git
cd memos

npm install
cd web && npm install && cd ..

npx wrangler login
# 或在 CI 中设置 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID

npm run cf:doctor   # 检查账号、资源与配置
npm run cf:setup    # 查找或创建 D1（按需创建 R2 / KV），生成 wrangler.local.toml
npm run cf:init     # 对远程 D1 应用 migrations
npm run cf:deploy   # 构建前端 + 迁移 + 写入 JWT_SECRET + 部署
```

`npm run cf:deploy` 会依次执行 `setup → build → init → deploy`：

- 默认只查找或创建 D1 数据库，R2 / KV 默认关闭；
- 需要 R2 时设置 `CFMEMOS_ENABLE_R2=true`，需要 KV 时设置 `CFMEMOS_ENABLE_KV=true`；
- 资源名称可通过 `CFMEMOS_D1_NAME`、`CFMEMOS_R2_BUCKET`、`CFMEMOS_KV_NAME` 覆盖，默认均为 `memos`；
- 真实资源 ID 只写入 Git 忽略的 `wrangler.local.toml`；
- `JWT_SECRET` 优先取环境变量，其次读取 `.dev.vars`，都没有时自动生成；
- 仅在远程 Worker 尚无 `JWT_SECRET` 时写入 Secret，重复部署不会轮换密钥；
- 幂等，可反复执行。

`npm run deploy` 只是原生的 `wrangler deploy`，要求 `web/dist` 已构建、`wrangler.local.toml`（或环境变量 / Secrets）已就绪。

### 方式二：Cloudflare Dashboard 导入 Git 仓库

1. Fork 本仓库；
2. 进入 **Workers & Pages → Create application → Import a repository**，选择 Fork 与 `main`；
3. **Build settings**：
   - Root directory 留空；
   - Build command **留空**（部署命令会自行构建前端）；
   - Deploy command：`npm run cf:deploy`；
4. **API token**：不要使用 Cloudflare 自动生成的默认 Token。默认 Token 只包含 Workers Scripts / KV / R2 权限，**不包含 D1**。请创建自定义 Token，至少包含：
   - Account → **Workers Scripts: Edit**
   - Account → **D1: Edit**
   - Account → **Workers R2 Storage: Edit**（仅启用 R2 时需要）
   - Account → **Workers KV Storage: Edit**（仅启用 KV 时需要）
5. 如需启用 R2 / KV，在 Build settings 中添加环境变量 `CFMEMOS_ENABLE_R2=true` / `CFMEMOS_ENABLE_KV=true`；也可通过 `CFMEMOS_D1_NAME`、`CFMEMOS_R2_BUCKET`、`CFMEMOS_KV_NAME` 改名；
6. 保存并部署。首次部署会创建 D1、生成 `wrangler.local.toml`、执行 migrations、写入 `JWT_SECRET` 并部署 Worker；
7. 访问 Worker URL，首次访问会进入管理员注册页面。

> 也可以拆分：Build command 填 `npm run build`，Deploy command 填 `npm run cf:deploy -- --skip-build`。
>
> 若使用 Cloudflare 默认的 `npx wrangler deploy`，仍需配置上面的自定义 API Token，并在 Build command 中执行 `npm run build`；默认命令不会自动执行数据库迁移。

### 方式三：手动创建资源

```bash
# 创建 D1 数据库（默认名称 memos）
npx wrangler d1 create memos

# 可选：启用 R2 时创建存储桶
npx wrangler r2 bucket create memos

# 生成包含真实资源 ID 的 wrangler.local.toml
# 启用 R2 / KV 时先设置 CFMEMOS_ENABLE_R2=true / CFMEMOS_ENABLE_KV=true
npm run cf:setup

# 初始化数据库
npm run cf:init

# 构建并部署（会自动生成并写入 JWT_SECRET）
npm run cf:deploy
```

## GitHub Actions 自动部署

推送到 `main` 分支会自动触发部署。在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret / Variable | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需要 Workers Scripts:Edit、D1:Edit；启用 R2 / KV 时还需要对应权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `JWT_SECRET` | 可选。首次部署时写入；未配置时脚本自动生成 |
| `CFMEMOS_ENABLE_R2` | 可选 Variable。设为 `true` 时创建/绑定 R2，默认关闭 |
| `CFMEMOS_ENABLE_KV` | 可选 Variable。设为 `true` 时创建/绑定 KV，默认关闭 |
| `CFMEMOS_D1_NAME` | 可选 Variable。D1 名称，默认 `memos` |
| `CFMEMOS_R2_BUCKET` | 可选 Variable。R2 存储桶名称，默认 `memos` |
| `CFMEMOS_KV_NAME` | 可选 Variable。KV 命名空间名称，默认 `memos` |

工作流会安装依赖、构建前端、创建或复用资源、执行迁移、写入 `JWT_SECRET` 并部署 Worker。版本号由 `scripts/fetch-github-version.mjs` 从上游 `usememos/memos` 的最新 Release 解析。

## 本地开发

```bash
npm install
cd web && npm install && cd ..

npm run db:migrate   # 初始化本地 D1
npm run dev          # Worker 后端，端口 8787
```

另开一个终端：

```bash
npm run dev:web      # 前端开发服务器，端口 3001
```

浏览器访问 `http://localhost:3001`。

本地开发需要 JWT 签名密钥，可在根目录创建（已被 Git 忽略）：

```bash
# .dev.vars
JWT_SECRET=your-local-development-secret-at-least-32-characters
```

## 项目结构

```
├── wrangler.toml              # Cloudflare 配置（D1 + AI，R2 / KV 可选）
├── package.json               # 根 package，部署脚本
├── scripts/
│   ├── cloudflare-deploy.mjs  # 自动创建/绑定/初始化/部署
│   └── fetch-github-version.mjs
├── migrations/
│   ├── 0001_initial.sql       # 用户、备忘录、附件、评论、分享、SSO 等
│   ├── 0002_webhooks.sql      # Webhook
│   ├── 0003_performance_indexes.sql
│   └── 0004_spaces.sql        # 空间、SPACE 可见性、备忘录 space_id
├── worker/
│   └── src/
│       ├── index.ts           # Hono 入口与路由挂载
│       ├── types.ts           # Env 绑定与 JWT 类型
│       ├── routes/
│       │   ├── auth.ts        # 登录 / 注册 / 刷新令牌
│       │   ├── memos.ts       # 备忘录 CRUD、评论、反应、分享
│       │   ├── users.ts       # 用户、设置、PAT、通知、Memo Views、用量
│       │   ├── spaces.ts      # 空间、成员、邀请
│       │   ├── attachments.ts # 附件上传与删除
│       │   ├── files.ts       # 文件下载
│       │   ├── instance.ts    # 实例配置、上传策略、统计
│       │   ├── ai.ts          # Workers AI 转写
│       │   ├── idp.ts         # SSO 身份提供商
│       │   ├── shortcuts.ts
│       │   └── sse.ts
│       ├── auth/              # JWT、密码哈希、PAT
│       ├── db/                # D1 查询模块（memo / space / user / setting 等）
│       ├── filter/            # 备忘录过滤表达式编译
│       ├── storage/           # R2 / S3 / WebDAV 与上传策略
│       └── middleware/
└── web/
    └── src/
        ├── connect.ts         # REST 客户端
        ├── contexts/
        ├── components/
        ├── pages/             # 含 Spaces、SpaceDetail、Calendar、Map、MemoViews
        ├── hooks/
        ├── locales/
        └── shims/             # @bufbuild/protobuf / Connect 兼容层
```

## API 概览

所有接口均为 JSON，认证使用 `Authorization: Bearer <JWT 或 PAT>`。错误统一为 `{ "code": number, "message": string, "details": [] }`。

| 路径 | 说明 |
|------|------|
| `/api/v1/auth/*` | 登录、注册、刷新、当前用户、OAuth |
| `/api/v1/memos` | 备忘录列表 / 创建；`/:id` 支持 uid 或数字 ID |
| `/api/v1/memos/:id/{attachments,relations,comments,reactions,shares}` | 关联资源 |
| `/api/v1/users` | 用户管理、设置、PAT、通知、Memo Views、用量 |
| `/api/v1/spaces` | 空间、成员、邀请、接受 / 拒绝 |
| `/api/v1/attachments` | 附件列表、上传、更新、删除 |
| `/api/v1/instance` | 实例 profile、设置、上传配置、统计 |
| `/api/v1/identity-providers` | SSO 身份提供商 |
| `/api/v1/sse` | 实时事件 |
| `/file/*` | 附件文件访问 |
| `/u/:username/rss.xml` | 用户 RSS |
| `/explore/rss.xml` | Explore RSS |

## 配置

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥；未设置时 `cf:deploy` 会自动生成 | 是 |
| `INSTANCE_NAME` | 实例名称，显示在页面标题 | 否 |
| `APP_VERSION` | 实例版本号，默认 `26.11.0` | 否 |
| `CFMEMOS_ENABLE_R2` | 设为 `true` / `1` 时创建并绑定 R2 | 否 |
| `CFMEMOS_ENABLE_KV` | 设为 `true` / `1` 时创建并绑定 KV | 否 |
| `CFMEMOS_D1_NAME` | D1 数据库名称，默认 `memos` | 否 |
| `CFMEMOS_R2_BUCKET` | R2 存储桶名称，默认 `memos` | 否 |
| `CFMEMOS_KV_NAME` | KV 命名空间名称，默认 `memos` | 否 |

敏感变量通过 `wrangler secret put` 设置；非敏感变量在 `wrangler.toml` 的 `[vars]` 中配置。

### Cloudflare 资源绑定

| 绑定名 | 类型 | 用途 |
|--------|------|------|
| `DB` | D1 Database | 必选。用户、备忘录、空间、设置等结构化数据 |
| `BUCKET` | R2 Bucket（可选） | 附件文件；`CFMEMOS_ENABLE_R2=true` 时启用 |
| `CACHE` | KV Namespace（可选） | 实例统计、用户统计、链接元数据缓存；`CFMEMOS_ENABLE_KV=true` 时启用 |
| `AI` | Workers AI | 音频转写 |
| `ASSETS` | Static Assets | 前端构建产物 |

未启用 R2 时，可在实例设置中选择 S3 兼容存储或 WebDAV；两者都未配置时附件上传会失败，其他功能不受影响。

## 文件上传限制

上传大小**可以自定义**，默认 **100 MiB**。

- 管理员在 **设置 → 存储 → 最大上传大小（MiB）** 中修改，范围为 1–100 MiB；保存后立即对新上传生效。
- 该值保存在实例 `STORAGE` 设置的 `uploadSizeLimitMb` 字段中。
- 编辑器会在选择文件时先检查大小，Worker 在上传接口再次校验，超过限制返回 `413` 和 `message.maximum-upload-size-is` 错误。
- 图片预处理（压缩、缩放、格式转换）发生在浏览器端，可减小实际上传体积。
- Cloudflare 自身还有请求体大小上限，可能低于配置值；免费套餐通常为 100 MB。
- 修改限制不会影响已经上传的附件。

通过 API 修改时，`PATCH /api/v1/instance/settings/STORAGE` 会**整体替换** `storageSetting`，因此需要同时提交完整的存储配置（存储类型、路径模板、S3 / WebDAV 配置等）；一般建议直接在管理界面修改，以免覆盖其他存储字段。

上传配置包含：

| 字段 | 说明 |
|------|------|
| `storageType` | `R2` / `S3` / `WEBDAV` |
| `uploadSizeLimitMb` | 单文件大小限制，默认 100 |
| `filepathTemplate` | 对象键模板，支持 `{username}`、`{date}`、`{shortId}`、`{ext}` 等 |
| `imageProcessing` | 浏览器端图片预处理开关、质量、最长边、输出格式 |

## 数据库迁移

| 迁移 | 内容 |
|------|------|
| `0001_initial.sql` | 用户、用户设置、备忘录、关系、附件、IDP、收件箱、反应、分享、Linked Identity |
| `0002_webhooks.sql` | Webhook |
| `0003_performance_indexes.sql` | 查询索引 |
| `0004_spaces.sql` | 空间、空间成员；重建 `memo` 以支持 `SPACE` 可见性与 `space_id` |

```bash
npm run db:migrate          # 本地 D1
npm run db:migrate:remote   # 远程 D1（等价于 npm run cf:init）
```

## 自定义域名

1. Workers & Pages → 选择 Worker → Settings → Domains & Routes；
2. 添加自定义域名（域名需已托管在 Cloudflare DNS 中）。

## 常见问题

**Q: 部署后访问显示空白页？**

确认 `web/dist/` 已生成。`npm run build` 或 `npm run cf:deploy` 会构建前端；`wrangler deploy` 会自动上传该目录。

**Q: Dashboard 部署时报无权限创建 D1？**

Workers Builds 自动生成的 API Token 不包含 D1 权限。按“方式二”第 4 步创建包含 **D1: Edit** 的自定义 Token，并在 **Settings → Build → API token** 中选择。

**Q: 访问 `/api/*` 返回前端 404 页面？**

确认 `wrangler.toml` 的 `[assets]` 包含：

```toml
run_worker_first = ["/api/*", "/file/*", "/u/*", "/explore/rss.xml"]
```

**Q: 如何修改附件上传大小限制？**

在 **设置 → 存储 → 最大上传大小** 修改，或通过 `PATCH /api/v1/instance/settings/STORAGE` 设置 `uploadSizeLimitMb`。注意 Cloudflare 自身的请求体上限仍会生效。

**Q: 上传附件返回 413？**

文件超过当前 `uploadSizeLimitMb`，或超过 Cloudflare 套餐的请求体限制。可降低限制值、压缩图片，或在本地/对象存储侧完成上传。

**Q: 数据库报错 `table not found`？**

执行 `npm run db:migrate:remote` 或 `npm run cf:init` 初始化远程数据库。

**Q: 如何备份数据？**

```bash
# 导出 D1
wrangler d1 export memos --remote --output=backup.sql

# R2 文件可通过 rclone 或 Cloudflare Dashboard 下载
```

**Q: 免费额度够用吗？**

Cloudflare Workers Free Plan 包含每天 10 万次请求、D1 5GB 存储、R2 10GB 存储 + 每月 1000 万次读取。个人使用通常足够。

## License

MIT
