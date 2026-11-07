/** 事件渲染:把 Event 列表压成带序号的一行行文本,供模型输入与证据 seq 对齐。 */
import type { Event } from '../events/schema.js';
import { truncateText } from './select.js';

export function renderEvents(events: Event[]): string {
  return events
    .map((e) => {
      const text = e.text ?? (typeof e.result?.output === 'string' ? e.result.output : '');
      const kind = e.kind === 'tool_result' && e.result?.status === 'error' ? 'error' : e.kind;
      let line = `[${e.seq}] ${kind}${text ? `: ${text}` : ''}`;
      // 溯源:raw 文件行号 + tool 入参(可能含 URL/路径),供 resources 记忆完全可溯源。
      if (e.raw) line += ` @${e.raw.path}:${e.raw.line}`;
      if (e.tool?.input !== undefined) {
        const input = typeof e.tool.input === 'string' ? e.tool.input : JSON.stringify(e.tool.input);
        // 截断:Write/Edit 等工具的入参可能含整篇文件内容,不截会让转录超模型上限。
        if (input && input !== 'undefined') line += ` (input: ${truncateText(input)})`;
      }
      return line;
    })
    .join('\n');
}
