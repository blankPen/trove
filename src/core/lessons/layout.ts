/** lessons 目录骨架(0.2 实体化口径)的幂等初始化。INDEX.md 初始为空索引但分区标题齐全。 */
import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryLessonsDir } from '../layout.js';

const SUBDIRS = [
  'preferences',
  'entities/projects',
  'entities/people',
  'entities/organizations',
  'entities/tools',
  'entities/tech',
  'experiences',
  'events',
  'resources/docs',
  'resources/repos',
  'resources/links',
  'archive/preferences',
  'archive/entities',
  'archive/experiences',
  'archive/events',
  'archive/resources',
];

export const INDEX_TEMPLATE = [
  '# INDEX',
  '',
  '## Preferences',
  '',
  '## Entities',
  '',
  '## Experiences',
  '',
  '## Events',
  '',
  '## Resources',
  '',
].join('\n');

const OVERVIEW_TEMPLATE = '# 学习沉淀概览\n\n';

export async function ensureLessonsLayout(vaultRoot: string): Promise<void> {
  const root = libraryLessonsDir(vaultRoot);
  await mkdir(root, { recursive: true });
  for (const sub of SUBDIRS) {
    await mkdir(join(root, sub), { recursive: true });
  }
  await ensureFile(join(root, 'INDEX.md'), INDEX_TEMPLATE);
  await ensureFile(join(root, '.overview.md'), OVERVIEW_TEMPLATE);
}

async function ensureFile(path: string, content: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    await writeFile(path, content, 'utf8');
  }
}