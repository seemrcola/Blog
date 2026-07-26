# Personal Blog

## 本地开发

```sh
npm install
npm run dev
```

文章放在 `src/content/blog/`，复制现有 Markdown 文件即可新增文章。设置 `draft: true` 可以暂时隐藏草稿。

## Cloudflare Pages

将项目推送到 GitHub，然后在 Cloudflare Pages 中导入仓库：

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: `22`
