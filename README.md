# mp4jpeg-gif

用 Cloudflare **R2 + Worker** 储存视频、图片和动图。

## 当前实现

这个仓库现在提供了一个最小可部署方案：

- `GET /`：浏览器上传页面
- `POST /api/uploads/sign`：生成 R2 预签名上传 URL（需要管理员令牌）
- `POST /api/uploads/complete`：上传完成后确认对象已写入 R2，并更新状态（需要管理员令牌）
- `GET /api/uploads/:uploadId`：查询上传记录（需要管理员令牌）

文件本体和上传状态都存到同一个 R2 Bucket：

- 文件：`uploads/YYYY-MM-DD/<uploadId>-<filename>`
- 元数据：`meta/<uploadId>.json`

## 本地开发

```bash
npm install
npm run dev
```

## 部署前需要创建的 Cloudflare 资源

### 1. 创建 R2 Bucket

示例 bucket 名：`mp4jpeg-gif-uploads`

然后确认 `wrangler.jsonc` 里的 `bucket_name` 与实际 bucket 一致。

### 2. 创建 R2 API Token / S3 兼容凭证

需要准备：

- `ADMIN_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `ALLOWED_ORIGINS`（可选，多个域名用逗号分隔）

其中：

- `ADMIN_TOKEN`：你的后台上传访问令牌，必须足够长且随机
- `R2_ACCOUNT_ID`：Cloudflare Account ID
- `R2_BUCKET_NAME`：R2 Bucket 名称
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`：R2 S3 API 凭证
- `ALLOWED_ORIGINS`：允许调用 Worker API 的前端域名列表；未配置时默认只允许 Worker 自己的同源页面

### 3. 配置 Worker secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_BUCKET_NAME
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

如果你有单独前端域名，再额外配置：

```bash
npx wrangler secret put ALLOWED_ORIGINS
```

值示例：

```text
https://upload.example.com,https://admin.example.com
```

## R2 CORS 配置

浏览器会使用预签名 URL 直接 PUT 到 R2，所以 bucket 必须允许跨域上传。

可先使用类似下面的 CORS 规则：

```json
[
  {
    "AllowedOrigins": ["https://<your-worker-domain>"],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

如果你本地调试，还需要临时加上：

- `http://127.0.0.1:8787`
- `http://localhost:8787`

## 部署

```bash
npm run deploy
```

部署后：

1. 打开 Worker 域名
2. 先输入 `ADMIN_TOKEN`
3. 选择 mp4 / jpeg / gif / webp 文件
4. 页面会先带管理员令牌请求签名接口
5. 浏览器再直接上传到 R2
6. 上传完成后调用确认接口写入最终状态

## 接口说明

### `POST /api/uploads/sign`

请求头：

```text
Authorization: 管理员令牌
```

请求体：

```json
{
  "filename": "demo.mp4",
  "contentType": "video/mp4",
  "size": 123456
}
```

返回：

```json
{
  "uploadId": "uuid",
  "uploadUrl": "https://...",
  "method": "PUT",
  "headers": {
    "Content-Type": "video/mp4"
  },
  "expiresIn": 900
}
```

### `POST /api/uploads/complete`

请求头：

```text
Authorization: 管理员令牌
```

请求体：

```json
{
  "uploadId": "uuid"
}
```

### `GET /api/uploads/:uploadId`

请求头：

```text
Authorization: 管理员令牌
```

返回当前上传状态，例如：

```json
{
  "uploadId": "uuid",
  "status": "uploaded"
}
```

## 限制

当前默认限制：

- 允许类型：`video/mp4`、`video/quicktime`、`video/webm`、`image/jpeg`、`image/png`、`image/gif`、`image/webp`
- 单文件最大：500MB
- 预签名 URL 有效期：15 分钟

## 当前安全加固

当前版本已默认启用：

- 所有敏感 API 都要求 `Bearer` 访问令牌
- 默认拒绝跨站调用，只允许同源；可通过 `ALLOWED_ORIGINS` 精确放行
- 返回结果已去掉 R2 对象路径等不必要内部信息
- 基本安全响应头：`Content-Security-Policy`、`Strict-Transport-Security`、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`
- 令牌比较使用常量时间比较，降低简单时序泄露风险
- 上传 ID、文件名、类型、大小都做了更严格校验

> 注意：这已经比原始版本安全很多，但“不可能”做到绝对无法被攻击。真正高强度防护还需要你在 Cloudflare 控制台继续开启 WAF、Bot Fight Mode、Access、Turnstile、日志审计和最小权限策略。

## 建议继续开启的 Cloudflare 安全能力

- 给管理页面和 API 前面加 **Cloudflare Access**
- 开启 **WAF** 与 **Bot Fight Mode**
- 给上传入口加 **Turnstile**
- 只给 R2 凭证最小权限，不要复用主账号高权限 token
- 生产环境只允许你自己的后台域名出现在 `ALLOWED_ORIGINS`
- 定期轮换 `ADMIN_TOKEN`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`
- 不要把任何用户敏感信息直接存进前端、URL 或 R2 元数据

## 验证建议

上线前至少验证：

- 大文件上传是否成功
- 未带 `Authorization` 时接口是否返回 401/403
- 非允许来源调用 API 时是否返回 403
- bucket CORS 是否正确
- 非白名单 MIME 类型是否被拒绝
- 过期预签名 URL 是否失效
- `GET /api/uploads/:uploadId` 是否能查到最终状态

## 代码位置

- Worker 入口：`src/index.js`
- Wrangler 配置：`wrangler.jsonc`
