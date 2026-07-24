# mp4jpeg-gif

用图片、视频或动图快速生成一个可访问链接，并支持绑定自己的域名。

## 使用方式

部署后通过 `media` 参数传入资源地址：

```text
https://你的域名/?media=https://example.com/demo.gif
https://你的域名/?media=https://example.com/demo.jpg
https://你的域名/?media=https://example.com/demo.mp4
```

页面会自动识别资源类型：

- `mp4 / webm / ogg` 使用 `<video>` 播放
- `gif / jpg / jpeg / png / webp / avif / svg` 使用 `<img>` 展示

## 部署（GitHub Pages + 自定义域名）

1. 把仓库内容推送到 GitHub。
2. 在仓库 `Settings -> Pages` 中启用 Pages（选择根目录 `/`）。
3. 在 `Custom domain` 中填写你的域名（例如 `media.example.com`）。
4. 按 GitHub 提示为你的域名配置 DNS（通常是 `CNAME` 记录）。
5. 等待证书签发后，使用上面的 `?media=` 链接即可访问。
