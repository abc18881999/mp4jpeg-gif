const ALLOWED_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;
const PRESIGNED_URL_TTL_SECONDS = 900;
const META_PREFIX = 'meta/';
const OBJECT_PREFIX = 'uploads/';
const API_PREFIX = '/api/uploads';
const ADMIN_TOKEN_ENV_KEY = 'ADMIN_TOKEN';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith(API_PREFIX) && request.method === 'OPTIONS') {
        return buildPreflightResponse(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/') {
        const cspNonce = crypto.randomUUID().replaceAll('-', '');
        return htmlResponse(renderPage(cspNonce), { cspNonce });
      }

      if (request.method === 'POST' && url.pathname === `${API_PREFIX}/sign`) {
        return handleSignUpload(request, env);
      }

      if (request.method === 'POST' && url.pathname === `${API_PREFIX}/complete`) {
        return handleCompleteUpload(request, env);
      }

      if (request.method === 'GET' && url.pathname.startsWith(`${API_PREFIX}/`)) {
        const uploadId = url.pathname.replace(`${API_PREFIX}/`, '');
        return handleGetUpload(request, env, uploadId);
      }

      return jsonResponse({ error: 'Not found' }, 404, request, env);
    } catch (error) {
      console.error(error);
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status, request, env);
      }

      return jsonResponse({ error: 'Internal server error' }, 500, request, env);
    }
  },
};

async function handleSignUpload(request, env) {
  assertEnv(env);
  assertAuthorizedRequest(request, env);

  const { filename, contentType, size } = await readJson(request);
  validateUploadRequest({ filename, contentType, size });

  const uploadId = crypto.randomUUID();
  const objectKey = buildObjectKey(uploadId, filename);
  const now = new Date();
  const uploadUrl = await createPresignedPutUrl({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    objectKey,
    contentType,
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
    now,
  });

  const record = {
    uploadId,
    filename,
    contentType,
    size,
    objectKey,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PRESIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };

  await env.UPLOAD_BUCKET.put(metaKey(uploadId), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return jsonResponse({
    uploadId,
    uploadUrl,
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
  }, 200, request, env);
}

async function handleCompleteUpload(request, env) {
  assertEnv(env);
  assertAuthorizedRequest(request, env);
  const { uploadId } = await readJson(request);
  if (!uploadId) {
    throw new HttpError(400, 'uploadId is required');
  }

  const existing = await loadRecord(uploadId, env);
  if (!existing) {
    throw new HttpError(404, 'Upload record not found');
  }

  const object = await env.UPLOAD_BUCKET.head(existing.objectKey);
  if (!object) {
    throw new HttpError(409, 'Uploaded object not found in R2');
  }

  const updated = {
    ...existing,
    status: 'uploaded',
    uploadedAt: new Date().toISOString(),
    etag: object.httpEtag,
    storedSize: object.size,
  };

  await env.UPLOAD_BUCKET.put(metaKey(uploadId), JSON.stringify(updated, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return jsonResponse(sanitizeRecordForClient(updated), 200, request, env);
}

async function handleGetUpload(request, env, uploadId) {
  assertEnv(env);
  validateUploadId(uploadId);
  assertAuthorizedRequest(request, env);
  const record = await loadRecord(uploadId, env);
  if (!record) {
    throw new HttpError(404, 'Upload record not found');
  }

  return jsonResponse(sanitizeRecordForClient(record), 200, request, env);
}

async function loadRecord(uploadId, env) {
  const object = await env.UPLOAD_BUCKET.get(metaKey(uploadId));
  if (!object) {
    return null;
  }

  return JSON.parse(await object.text());
}

function metaKey(uploadId) {
  return `${META_PREFIX}${uploadId}.json`;
}

function validateUploadRequest({ filename, contentType, size }) {
  if (!filename || typeof filename !== 'string') {
    throw new HttpError(400, 'filename is required');
  }

  if (filename.length > 255) {
    throw new HttpError(400, 'filename is too long');
  }

  if (!contentType || typeof contentType !== 'string') {
    throw new HttpError(400, 'contentType is required');
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new HttpError(400, `Unsupported content type: ${contentType}`);
  }

  if (!Number.isFinite(size) || size <= 0) {
    throw new HttpError(400, 'size must be a positive number');
  }

  if (size > MAX_UPLOAD_SIZE) {
    throw new HttpError(400, `size exceeds limit of ${MAX_UPLOAD_SIZE} bytes`);
  }
}

function validateUploadId(uploadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
    throw new HttpError(400, 'Invalid uploadId');
  }
}

function sanitizeRecordForClient(record) {
  return {
    uploadId: record.uploadId,
    filename: record.filename,
    contentType: record.contentType,
    size: record.size,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    uploadedAt: record.uploadedAt ?? null,
    storedSize: record.storedSize ?? null,
  };
}

function buildObjectKey(uploadId, filename) {
  const safeName = filename
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'upload.bin';

  const date = new Date().toISOString().slice(0, 10);
  return `${OBJECT_PREFIX}${date}/${uploadId}-${safeName}`;
}

async function createPresignedPutUrl({
  accountId,
  bucket,
  accessKeyId,
  secretAccessKey,
  objectKey,
  contentType,
  expiresIn,
  now,
}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const pathname = `/${bucket}/${encodeR2Path(objectKey)}`;
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'content-type;host',
  });

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = [
    'PUT',
    pathname,
    query.toString(),
    canonicalHeaders,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, 'auto', 's3');
  const signature = await hmacHex(signingKey, stringToSign);
  query.set('X-Amz-Signature', signature);

  return `https://${host}${pathname}?${query.toString()}`;
}

function encodeR2Path(objectKey) {
  return objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function assertEnv(env) {
  const required = ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'UPLOAD_BUCKET', ADMIN_TOKEN_ENV_KEY];
  for (const key of required) {
    if (!env[key]) {
      throw new HttpError(500, `Missing required environment binding: ${key}`);
    }
  }
}

function assertAuthorizedRequest(request, env) {
  assertAllowedOrigin(request, env);
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing bearer token');
  }

  const providedToken = authHeader.slice('Bearer '.length).trim();
  if (!providedToken || !constantTimeEqual(providedToken, env[ADMIN_TOKEN_ENV_KEY])) {
    throw new HttpError(403, 'Invalid bearer token');
  }
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) {
    return;
  }

  const requestUrl = new URL(request.url);
  const allowedOrigins = getAllowedOrigins(env, requestUrl.origin);
  if (!allowedOrigins.has(origin)) {
    throw new HttpError(403, 'Origin not allowed');
  }
}

function getAllowedOrigins(env, requestOrigin) {
  const configuredOrigins = String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set([requestOrigin, ...configuredOrigins]);
}

function buildPreflightResponse(request, env) {
  assertAllowedOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: buildSecurityHeaders({
      contentType: null,
      extraHeaders: buildCorsHeaders(request, env),
    }),
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function renderPage(cspNonce) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>R2 上传</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 720px; padding: 0 1rem; }
      form, .panel { border: 1px solid #ddd; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
      button { cursor: pointer; }
      pre { background: #111; color: #eee; padding: 1rem; border-radius: 12px; overflow: auto; }
      .muted { color: #666; }
    </style>
  </head>
  <body>
    <h1>Cloudflare R2 上传</h1>
    <p class="muted">前端先向 Worker 申请预签名 URL，再直接把文件上传到 R2。</p>
    <form id="upload-form">
      <label>
        访问令牌
        <input id="token-input" name="token" type="password" autocomplete="current-password" required />
      </label>
      <div style="margin-top: 1rem;"></div>
      <label>
        选择文件
        <input id="file-input" name="file" type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/gif,image/webp" required />
      </label>
      <div style="margin-top: 1rem;">
        <button type="submit">开始上传</button>
      </div>
    </form>

    <div class="panel">
      <strong>状态</strong>
      <pre id="output">等待上传…</pre>
    </div>

    <script nonce="${cspNonce}">
      const form = document.getElementById('upload-form');
      const tokenInput = document.getElementById('token-input');
      const fileInput = document.getElementById('file-input');
      const output = document.getElementById('output');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = fileInput.files[0];
        const token = tokenInput.value.trim();
        if (!file) {
          output.textContent = '请先选择文件';
          return;
        }
        if (!token) {
          output.textContent = '请先填写访问令牌';
          return;
        }

        try {
          output.textContent = '1/3 申请上传地址…';

          const signResponse = await fetch('/api/uploads/sign', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              filename: file.name,
              contentType: file.type,
              size: file.size,
            }),
          });

          const signPayload = await signResponse.json();
          if (!signResponse.ok) {
            output.textContent = JSON.stringify(signPayload, null, 2);
            return;
          }

          output.textContent = '2/3 上传文件到 R2…';
          const uploadResponse = await fetch(signPayload.uploadUrl, {
            method: signPayload.method,
            headers: signPayload.headers,
            body: file,
          });

          if (!uploadResponse.ok) {
            output.textContent = '上传失败: ' + uploadResponse.status + ' ' + uploadResponse.statusText;
            return;
          }

          output.textContent = '3/3 确认上传结果…';
          const completeResponse = await fetch('/api/uploads/complete', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ uploadId: signPayload.uploadId }),
          });

          const completePayload = await completeResponse.json();
          output.textContent = JSON.stringify(completePayload, null, 2);
        } catch (error) {
          output.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    </script>
  </body>
</html>`;
}

function jsonResponse(payload, status = 200, request = null, env = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: buildSecurityHeaders({
      contentType: 'application/json; charset=utf-8',
      extraHeaders: request ? buildCorsHeaders(request, env) : {},
    }),
  });
}

function htmlResponse(html, options = {}) {
  return new Response(html, {
    headers: buildSecurityHeaders({
      contentType: 'text/html; charset=utf-8',
      cspNonce: options.cspNonce ?? null,
    }),
  });
}

function buildSecurityHeaders({ contentType, cspNonce = null, extraHeaders = {} }) {
  const headers = {
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders,
  };

  if (contentType) {
    headers['content-type'] = contentType;
  }

  if (cspNonce) {
    headers['content-security-policy'] = [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self' https://*.r2.cloudflarestorage.com",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      `script-src 'nonce-${cspNonce}'`,
      "style-src 'unsafe-inline'",
    ].join('; ');
  }

  return headers;
}

function buildCorsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) {
    return {};
  }

  const requestUrl = new URL(request.url);
  const allowedOrigins = getAllowedOrigins(env, requestUrl.origin);
  if (!allowedOrigins.has(origin)) {
    return {};
  }

  return {
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': origin,
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
}

async function hmacHex(key, value) {
  return toHex(await hmac(key, value));
}

async function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(String(left));
  const rightBytes = new TextEncoder().encode(String(right));
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
