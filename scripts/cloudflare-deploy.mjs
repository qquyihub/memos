#!/usr/bin/env node
/**
 * Cloudflare 资源自动创建、绑定与初始化。
 *
 * 参考 CF-Navs / cloudflare_temp_email / edgeever 的部署约定：
 * - 仓库中的 wrangler.toml 不保存真实资源 ID；
 * - 默认仅使用 D1；R2 / KV 需通过 CFMEMOS_ENABLE_R2 / CFMEMOS_ENABLE_KV 显式开启；
 * - D1 / R2 / KV 的资源名称均可用变量覆盖，默认都是 memos；
 * - 本脚本按名称查找或创建已启用的资源；
 * - 生成被 Git 忽略的 wrangler.local.toml 完成绑定；
 * - 自动执行 D1 migrations、写入 JWT_SECRET、构建并部署。
 *
 * 用法：node scripts/cloudflare-deploy.mjs <doctor|setup|init|deploy> [--dry-run] [--skip-build]
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const rootDir = resolve(process.cwd());
const baseConfigPath = resolve(rootDir, "wrangler.toml");
const localConfigPath = resolve(rootDir, "wrangler.local.toml");
const secretsFilePath = resolve(rootDir, ".wrangler.secrets.json");
const devVarsPath = resolve(rootDir, ".dev.vars");
const migrationsDir = resolve(rootDir, "migrations");
const wranglerBin = resolve(rootDir, "node_modules/wrangler/bin/wrangler.js");

const command = process.argv[2] ?? "doctor";
const dryRun = process.argv.includes("--dry-run");
const skipBuild = process.argv.includes("--skip-build");
const isCI = process.env.CI === "true" || process.env.WORKERS_CI === "1" || process.env.WORKERS_CI === "true";
const commands = new Set(["doctor", "setup", "init", "deploy"]);

const d1Name = (process.env.CFMEMOS_D1_NAME || "memos").trim();
const r2Bucket = (process.env.CFMEMOS_R2_BUCKET || "memos").trim();
const kvName = (process.env.CFMEMOS_KV_NAME || "memos").trim();
const kvBinding = "CACHE";
const parseFlag = (value) =>
  ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
// 默认只使用 D1；R2 / KV 通过变量显式启用。
const r2Enabled = parseFlag(process.env.CFMEMOS_ENABLE_R2);
const kvEnabled = parseFlag(process.env.CFMEMOS_ENABLE_KV);
const jwtSecretName = "JWT_SECRET";
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

if (!commands.has(command)) {
  console.error("用法: node scripts/cloudflare-deploy.mjs <doctor|setup|init|deploy> [--dry-run]");
  process.exit(1);
}

const stripAnsi = (value) => String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");

const run = (executable, args, options = {}) =>
  spawnSync(executable, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
    shell: false,
    ...options,
  });

const runWrangler = (args, options = {}) => {
  if (existsSync(wranglerBin)) {
    return run(process.execPath, [wranglerBin, ...args], options);
  }
  return run("npx", ["wrangler", ...args], { shell: process.platform === "win32", ...options });
};

const log = (status, label, detail = "") => {
  const suffix = detail ? `: ${detail}` : "";
  console.log(`[${status}] ${label}${suffix}`);
};

const ok = (label, detail) => log("ok", label, detail);
const info = (label, detail) => log("info", label, detail);

const outputOf = (result) => stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).trim();

const fail = (label, result) => {
  log("fail", label);
  const details = outputOf(result);
  if (details) console.error(details);
  process.exitCode = 1;
};

const readBaseConfig = () => {
  if (!existsSync(baseConfigPath)) {
    throw new Error(`未找到 ${baseConfigPath}`);
  }
  return readFileSync(baseConfigPath, "utf8");
};

// 从基础配置中移除指定资源块（例如 [[r2_buckets]]），由脚本按变量决定是否重新生成。
const stripBlock = (config, header) => {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return config;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }

  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
};

const appendBlock = (config, lines) => `${config.trimEnd()}\n\n${lines.join("\n")}\n`;

const workerName = () => readBaseConfig().match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "cfmemos";

const ensureWrangler = () => {
  if (existsSync(wranglerBin)) return true;
  const version = run("npx", ["wrangler", "--version"], { shell: process.platform === "win32" });
  if (version.status !== 0) {
    fail("Wrangler", version);
    console.error("请先执行 npm install，或安装 wrangler >= 4。");
    return false;
  }
  return true;
};

const ensureAuth = () => {
  const result = runWrangler(["whoami"]);
  const details = outputOf(result);
  const authenticated =
    result.status === 0 &&
    !/not authenticated|unable to authenticate|please run .*login|authentication error/i.test(details);

  if (authenticated) {
    ok("Cloudflare 认证", "已登录");
    return true;
  }

  if (!isCI && process.stdin.isTTY) {
    info("Cloudflare 认证", "未登录，正在启动 wrangler login");
    const login = runWrangler(["login"], { stdio: "inherit" });
    if (login.status === 0) {
      ok("Cloudflare 认证", "登录成功");
      return true;
    }
  }

  fail("Cloudflare 认证", result);
  console.error(
    "请先执行 `npx wrangler login`，或设置 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID 环境变量。",
  );
  return false;
};

const listD1Databases = () => {
  const result = runWrangler(["d1", "list", "--json"]);
  if (result.status !== 0) return { status: result.status, databases: [] };

  try {
    const parsed = JSON.parse(stripAnsi(result.stdout));
    return { status: 0, databases: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { status: result.status, databases: [] };
  }
};

const findD1Id = () => {
  const { databases } = listD1Databases();
  const match = databases.find(
    (item) => item?.name === d1Name || item?.database_name === d1Name,
  );
  return match?.uuid ?? match?.id ?? match?.database_id ?? "";
};

const ensureD1 = () => {
  const existingId = findD1Id();
  if (existingId) {
    ok("D1 数据库", `${d1Name} (${existingId})`);
    return existingId;
  }

  info("D1 数据库", `未找到 ${d1Name}，准备创建`);
  if (dryRun) {
    ok("D1 数据库", `dry-run，将创建 ${d1Name}`);
    return "";
  }

  const created = runWrangler(["d1", "create", d1Name]);
  const createdOutput = outputOf(created);
  const createdId = createdOutput.match(uuidPattern)?.[0] ?? "";
  if (created.status === 0 && createdId) {
    ok("D1 数据库", `已创建 ${d1Name} (${createdId})`);
    return createdId;
  }

  if (/already exists|已存在/i.test(createdOutput)) {
    const reusedId = findD1Id();
    if (reusedId) {
      ok("D1 数据库", `已复用 ${d1Name} (${reusedId})`);
      return reusedId;
    }
  }

  fail("创建 D1 数据库", created);
  console.error(
    `请在 Cloudflare 控制台或具备 D1 编辑权限的账号下创建名为 ${d1Name} 的数据库，然后重试。`,
  );
  return "";
};

const listR2Buckets = () => {
  // wrangler r2 bucket list 没有 --json，输出形如：
  //   Listing buckets...
  //   name:          my-bucket
  //   creation_date: 2024-01-01T00:00:00Z
  // 每个桶是一个以空行分隔的键值块，因此只提取 name 字段。
  const result = runWrangler(["r2", "bucket", "list"]);
  if (result.status !== 0) return { status: result.status, buckets: [] };

  const buckets = outputOf(result)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*name\s*:\s*(\S+)\s*$/i)?.[1])
    .filter(Boolean);
  return { status: 0, buckets };
};

const hasR2Bucket = () => listR2Buckets().buckets.includes(r2Bucket);

const ensureR2 = () => {
  const { status, buckets } = listR2Buckets();
  if (status === 0 && buckets.includes(r2Bucket)) {
    ok("R2 存储桶", r2Bucket);
    return true;
  }

  info("R2 存储桶", `未找到 ${r2Bucket}，准备创建`);
  if (dryRun) {
    ok("R2 存储桶", `dry-run，将创建 ${r2Bucket}`);
    return true;
  }

  const created = runWrangler(["r2", "bucket", "create", r2Bucket]);
  const createdOutput = outputOf(created);
  if (created.status === 0) {
    ok("R2 存储桶", `已创建 ${r2Bucket}`);
    return true;
  }

  if (/already exists|已存在/i.test(createdOutput)) {
    ok("R2 存储桶", `已复用 ${r2Bucket}`);
    return true;
  }

  fail("创建 R2 存储桶", created);
  console.error("请确认账号已开通 R2，且 API Token 具备 R2 编辑权限。");
  return false;
};

const listKvNamespaces = () => {
  const result = runWrangler(["kv", "namespace", "list"]);
  if (result.status !== 0) return { status: result.status, namespaces: [] };

  try {
    const parsed = JSON.parse(stripAnsi(result.stdout));
    return { status: 0, namespaces: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { status: result.status, namespaces: [] };
  }
};

const findKvId = () => listKvNamespaces().namespaces.find((item) => item?.title === kvName)?.id ?? "";

const ensureKV = () => {
  const existingId = findKvId();
  if (existingId) {
    ok("KV 命名空间", `${kvName} (${existingId})`);
    return existingId;
  }

  info("KV 命名空间", `未找到 ${kvName}，准备创建`);
  if (dryRun) {
    ok("KV 命名空间", `dry-run，将创建 ${kvName}`);
    return "";
  }

  const created = runWrangler(["kv", "namespace", "create", kvName]);
  const createdOutput = outputOf(created);
  const createdId = createdOutput.match(uuidPattern)?.[0] ?? "";
  if (created.status === 0 && createdId) {
    ok("KV 命名空间", `已创建 ${kvName} (${createdId})`);
    return createdId;
  }

  if (/already exists|已存在/i.test(createdOutput)) {
    const reusedId = findKvId();
    if (reusedId) {
      ok("KV 命名空间", `已复用 ${kvName} (${reusedId})`);
      return reusedId;
    }
  }

  fail("创建 KV 命名空间", created);
  console.error(`请在 Cloudflare 控制台创建名为 ${kvName} 的 KV 命名空间，然后重试。`);
  return "";
};

const applyD1 = (config, databaseId) => {
  const blockStart = config.indexOf("[[d1_databases]]");
  if (blockStart < 0) {
    const idLine = databaseId ? `database_id = "${databaseId}"\n` : "";
    return `${config.trimEnd()}\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${d1Name}"\n${idLine}`;
  }

  const nextBlock = config.indexOf("\n[[", blockStart + "[[d1_databases]]".length);
  const blockEnd = nextBlock >= 0 ? nextBlock + 1 : config.length;
  const block = config.slice(blockStart, blockEnd);
  let updatedBlock = block.replace(
    /database_name\s*=\s*"[^"]*"/,
    `database_name = "${d1Name}"`,
  );

  if (databaseId) {
    updatedBlock = /database_id\s*=/.test(updatedBlock)
      ? updatedBlock.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${databaseId}"`)
      : updatedBlock.replace(
          /(database_name\s*=\s*"[^"]*")/,
          `$1\ndatabase_id = "${databaseId}"`,
        );
  }

  return `${config.slice(0, blockStart)}${updatedBlock}${config.slice(blockEnd)}`;
};

// 默认只保留 D1；R2 / KV 仅在对应变量开启时写入绑定。
const writeLocalConfig = (databaseId, kvId) => {
  let config = stripBlock(stripBlock(readBaseConfig(), "[[r2_buckets]]"), "[[kv_namespaces]]");
  config = applyD1(config, databaseId);

  if (r2Enabled) {
    config = appendBlock(config, [
      "[[r2_buckets]]",
      'binding = "BUCKET"',
      `bucket_name = "${r2Bucket}"`,
    ]);
  }

  if (kvEnabled) {
    config = appendBlock(config, [
      "[[kv_namespaces]]",
      `binding = "${kvBinding}"`,
      `id = "${kvId}"`,
    ]);
  }

  const banner = [
    "# 此文件由 scripts/cloudflare-deploy.mjs 自动生成，包含本账号的真实资源 ID。",
    "# 已加入 .gitignore，请勿提交。",
    "",
  ].join("\n");

  if (dryRun) {
    ok("本地配置", `dry-run，将生成 ${localConfigPath}`);
    return;
  }

  writeFileSync(localConfigPath, `${banner}${config.trimEnd()}\n`, "utf8");
  ok("本地配置", localConfigPath);
};

const parseDevVars = () => {
  const values = new Map();
  if (!existsSync(devVarsPath)) return values;

  for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
};

const upsertDevVar = (key, value) => {
  if (dryRun) return;
  const content = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "";
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
  const next = pattern.test(content)
    ? content.replace(pattern, () => `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(devVarsPath, next.replace(/^\n/, ""), "utf8");
};

const resolveJwtSecret = () => {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;

  const fromDevVars = parseDevVars().get(jwtSecretName)?.trim();
  if (fromDevVars) return fromDevVars;

  const generated = randomBytes(32).toString("hex");
  upsertDevVar(jwtSecretName, generated);
  ok("JWT_SECRET", "已生成并写入 .dev.vars");
  return generated;
};

const hasJwtSecret = () => {
  if (!existsSync(localConfigPath)) return false;

  const result = runWrangler([
    "secret",
    "list",
    "--format",
    "json",
    "--config",
    localConfigPath,
    "--name",
    workerName(),
  ]);
  if (result.status !== 0) return false;

  try {
    const secrets = JSON.parse(stripAnsi(result.stdout));
    return Array.isArray(secrets) && secrets.some((item) => item?.name === jwtSecretName);
  } catch {
    return false;
  }
};

const applyMigrations = () => {
  if (!existsSync(localConfigPath)) {
    throw new Error("尚未生成 wrangler.local.toml，请先执行 setup。");
  }
  if (!existsSync(migrationsDir)) {
    throw new Error(`未找到迁移目录 ${migrationsDir}`);
  }

  info("D1 migrations", `应用到 ${d1Name} (--remote)`);
  if (dryRun) {
    ok("D1 migrations", "dry-run，跳过");
    return true;
  }

  const result = runWrangler([
    "d1",
    "migrations",
    "apply",
    d1Name,
    "--remote",
    "--config",
    localConfigPath,
  ]);
  if (result.status !== 0) {
    fail("D1 migrations", result);
    return false;
  }

  ok("D1 migrations", "已完成");
  return true;
};

const buildWeb = () => {
  info("前端构建", "npm run build");
  if (dryRun) {
    ok("前端构建", "dry-run，跳过");
    return true;
  }

  // 使用根 build 脚本：先安装 web 依赖再构建，确保仅在控制台构建环境中也能生成 web/dist。
  const result = run("npm", ["run", "build"], { stdio: "inherit" });
  if (result.status !== 0) {
    log("fail", "前端构建");
    process.exitCode = 1;
    return false;
  }

  ok("前端构建", "web/dist 已生成");
  return true;
};

const deployWorker = () => {
  const args = ["deploy", "--config", localConfigPath, "--keep-vars"];
  const appVersion = process.env.APP_VERSION?.trim();
  if (appVersion) args.push("--var", `APP_VERSION:${appVersion}`);

  let secretsFileWritten = false;
  if (!hasJwtSecret()) {
    const secret = resolveJwtSecret();
    if (!dryRun) {
      writeFileSync(secretsFilePath, `${JSON.stringify({ [jwtSecretName]: secret })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      secretsFileWritten = true;
    }
    args.push("--secrets-file", secretsFilePath);
    info("Worker Secret", `将同时写入 ${jwtSecretName}`);
  } else {
    ok("Worker Secret", `${jwtSecretName} 已存在，保持不轮换`);
  }

  info("部署 Worker", `${workerName()} -> Cloudflare`);
  if (dryRun) {
    ok("部署 Worker", `dry-run，等效命令: wrangler ${args.join(" ")}`);
    return true;
  }

  const result = runWrangler(args, { stdio: "inherit" });
  if (secretsFileWritten) {
    rmSync(secretsFilePath, { force: true });
  }
  if (result.status !== 0) {
    log("fail", "部署 Worker");
    process.exitCode = 1;
    return false;
  }

  ok("部署 Worker", "成功");
  return true;
};

const setup = () => {
  if (!ensureWrangler() || !ensureAuth()) return false;

  const databaseId = ensureD1();
  if (!databaseId && !dryRun) return false;

  if (r2Enabled && !ensureR2()) return false;

  let kvId = "";
  if (kvEnabled) {
    kvId = ensureKV();
    if (!kvId && !dryRun) return false;
  }

  writeLocalConfig(databaseId, kvId);
  return true;
};

const doctor = () => {
  let passed = true;

  if (!existsSync(baseConfigPath)) {
    fail("wrangler.toml", { stdout: "", stderr: "" });
    passed = false;
  } else {
    ok("wrangler.toml", baseConfigPath);
  }

  if (!ensureWrangler()) passed = false;

  const auth = ensureAuth();
  passed = auth && passed;

  if (!auth) {
    console.log("[info] 跳过资源检查：尚未完成 Cloudflare 认证");
    process.exitCode = passed ? 0 : 1;
    return;
  }

  const databaseId = findD1Id();
  if (databaseId) {
    ok("D1 数据库", `${d1Name} (${databaseId})`);
  } else {
    log("fail", "D1 数据库", `未找到 ${d1Name}`);
    passed = false;
  }

  if (r2Enabled) {
    if (hasR2Bucket()) {
      ok("R2 存储桶", r2Bucket);
    } else {
      log("fail", "R2 存储桶", `未找到 ${r2Bucket}`);
      passed = false;
    }
  } else {
    info("R2 存储桶", "未启用，跳过");
  }

  if (kvEnabled) {
    const { status, namespaces } = listKvNamespaces();
    const found = namespaces.find((item) => item?.title === kvName);
    if (status === 0 && found) {
      ok("KV 命名空间", `${kvName} (${found.id})`);
    } else {
      log("fail", "KV 命名空间", `未找到 ${kvName}`);
      passed = false;
    }
  } else {
    info("KV 命名空间", "未启用，跳过");
  }

  if (existsSync(localConfigPath)) {
    ok("本地配置", localConfigPath);
  } else {
    log("fail", "本地配置", "未生成，请执行 npm run cf:setup");
    passed = false;
  }

  process.exitCode = passed ? 0 : 1;
};

const deploy = () => {
  if (!setup()) return;
  if (!skipBuild && !buildWeb()) return;
  if (!applyMigrations()) return;
  if (!deployWorker()) return;

  ok("完成", "资源已创建/复用、绑定已写入、数据库已迁移、Worker 已部署");
};

if (command === "doctor") {
  doctor();
} else if (command === "setup") {
  setup();
} else if (command === "init") {
  if (!existsSync(localConfigPath)) {
    if (!setup()) process.exit(1);
  }
  applyMigrations();
} else {
  deploy();
}
