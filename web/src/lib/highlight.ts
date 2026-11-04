import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// 只注册 trove 数据里真会出现的语言,core + 按需注册,不整包拖进来。
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

/** 按文件扩展名挑 highlight.js 语言;不认识返回 undefined(不染色)。 */
export function langOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'json':
      return 'json';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sql':
      return 'sql';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'xml':
    case 'html':
    case 'svg':
      return 'xml';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return undefined;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 返回已转义的着色 HTML;语言不认识就只转义不染色。 */
export function highlight(code: string, lang?: string): string {
  if (!lang) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
