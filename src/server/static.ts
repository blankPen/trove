import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 伺服构建好的前端。找不到文件时回落到 index.html(hash 路由,刷新不 404)。
 */
export async function serveStatic(
  root: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  // root 归一:去掉尾斜杠,前缀校验才对得上
  const base = normalize(root).replace(/[/\\]+$/, '');
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\])+/, '');
  const abs = join(base, ...rel.split('/'));
  if (!abs.startsWith(base + sep)) return false;

  let target = abs;
  try {
    const st = await stat(target);
    if (st.isDirectory()) target = join(target, 'index.html');
  } catch {
    target = join(base, 'index.html');
  }
  try {
    const st = await stat(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    });
    createReadStream(target).pipe(res);
    return true;
  } catch {
    return false;
  }
}
