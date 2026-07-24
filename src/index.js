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

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return htmlResponse(renderPage());
      }

      if (request.method === 'POST' && url.pathname === '/api/uploads/sign') {
        return handleSignUpload(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/uploads/complete') {
        return handleCompleteUpload(request, env);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/uploads/')) {
        const uploadId = url.pathname.replace('/api/uploads/', '');
        return handleGetUpload(uploadId, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error(error);
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status);
      }

      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

async function handleSignUpload(request, env) {
  assertEnv(env);

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
    objectKey,
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
  });
}

async function handleCompleteUpload(request, env) {
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

  return jsonResponse(updated);
}

async function handleGetUpload(uploadId, env) {
  const record = await loadRecord(uploadId, env);
  if (!record) {
    throw new HttpError(404, 'Upload record not found');
  }

  return jsonResponse(record);
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
  const required = ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'UPLOAD_BUCKET'];
  for (const key of required) {
    if (!env[key]) {
      throw new HttpError(500, `Missing required environment binding: ${key}`);
    }
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function renderPage() {
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

    <script>
      const form = document.getElementById('upload-form');
      const fileInput = document.getElementById('file-input');
      const output = document.getElementById('output');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = fileInput.files[0];
        if (!file) {
          output.textContent = '请先选择文件';
          return;
        }

        try {
          output.textContent = '1/3 申请上传地址…';

          const signResponse = await fetch('/api/uploads/sign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
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
