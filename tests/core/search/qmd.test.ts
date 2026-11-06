import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { qmdCollectionConfig, troveRelPath, LESSON_CATEGORIES } from '../../../src/core/search/qmd.js';

describe('qmd collection 配置', () => {
  it('lessons 的 5 个类目各注册一个 collection,路径指向类目目录', () => {
    const cfg = qmdCollectionConfig('/vault');
    expect(Object.keys(cfg.collections).sort()).toEqual([...LESSON_CATEGORIES].sort());
    expect(cfg.collections.experiences.path).toBe(join('/vault', 'library', 'lessons', 'experiences'));
    expect(cfg.collections.experiences.pattern).toBe('**/*.md');
  });

  it('每个类目挂一段人写描述(qmd 靠它补文档语义)', () => {
    const cfg = qmdCollectionConfig('/vault');
    for (const cat of LESSON_CATEGORIES) {
      const ctx = cfg.collections[cat].context?.['/'];
      expect(typeof ctx).toBe('string');
      expect((ctx ?? '').length).toBeGreaterThan(5);
    }
  });

  it('给了模型就写进 models.embed,不给就不带 models', () => {
    expect(qmdCollectionConfig('/vault', 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf').models).toEqual({
      embed: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
    });
    expect(qmdCollectionConfig('/vault').models).toBeUndefined();
  });
});

describe('troveRelPath', () => {
  it('qmd://<类目>/<相对路径> 还原成 lessons 相对路径', () => {
    expect(troveRelPath('qmd://experiences/gotcha-webdav.md')).toBe('experiences/gotcha-webdav.md');
    expect(troveRelPath('experiences/gotcha-webdav.md')).toBe('experiences/gotcha-webdav.md');
  });

  it('不在记忆类目下的路径返回 null', () => {
    expect(troveRelPath('qmd://archive/experiences/old.md')).toBeNull();
    expect(troveRelPath('qmd://experiences')).toBeNull();
    expect(troveRelPath('')).toBeNull();
  });
});
