# mp4jpeg-gif

用 Cloudflare **R2 + Worker** 储存视频、图片和动图。

## 当前实现

这个仓库现在提供了一个最小可部署方案：

- `GET /`：浏览器上传页面
- `POST /api/uploads/sign`：生成 R2 预签名上传 URL
- `POST /api/uploads/complete`：上传完成后确认对象已写入 R2，并更新状态
- `GET /api/uploads/:uploadId`：查询上传记录

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

- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

其中：

- `R2_ACCOUNT_ID`：Cloudflare Account ID
- `R2_BUCKET_NAME`：R2 Bucket 名称
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`：R2 S3 API 凭证

### 3. 配置 Worker secrets

```bash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_BUCKET_NAME
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
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
2. 选择 mp4 / jpeg / gif / webp 文件
3. 页面会先请求签名接口
4. 浏览器再直接上传到 R2
5. 上传完成后调用确认接口写入最终状态

## 接口说明

### `POST /api/uploads/sign`

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
  "objectKey": "uploads/2026-07-24/uuid-demo.mp4",
  "expiresIn": 900
}
```

### `POST /api/uploads/complete`

请求体：

```json
{
  "uploadId": "uuid"
}
```

### `GET /api/uploads/:uploadId`

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

## 验证建议

上线前至少验证：

- 大文件上传是否成功
- bucket CORS 是否正确
- 非白名单 MIME 类型是否被拒绝
- 过期预签名 URL 是否失效
- `GET /api/uploads/:uploadId` 是否能查到最终状态

## 代码位置

- Worker 入口：`src/index.js`
- Wrangler 配置：`wrangler.jsonc`
