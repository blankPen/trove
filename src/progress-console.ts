import { humanSize } from './format.js';
import type { Progress } from './progress.js';

export interface ConsoleProgressOptions {
  write: (s: string) => void;
  tty?: boolean;
  now?: () => number;
  intervalMs?: number;
}

/**
 * 终端进度:TTY 用 \r 原地刷新,管道/日志按固定间隔输出,
 * 避免一次 sync 刷出上万行。最后一项总是输出。
 */
export function createConsoleProgress(opts: ConsoleProgressOptions): Progress {
  const write = opts.write;
  const tty = opts.tty ?? false;
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? 1000;
  let phase = '';
  let lastPrint = 0;
  let lastLen = 0;

  const line = (text: string, final: boolean) => {
    if (tty) {
      const padded = text + ' '.repeat(Math.max(0, lastLen - text.length));
      write(`\r${padded}${final ? '\n' : ''}`);
      lastLen = final ? 0 : text.length;
    } else {
      write(`${text}\n`);
    }
  };

  return {
    phase(name, detail) {
      phase = name;
      lastPrint = 0;
      line(detail ? `[${name}] ${detail}` : `[${name}]`, true);
    },
    item(label, current, total, bytes = 0) {
      const t = now();
      const final = total > 0 && current >= total;
      if (!tty && !final && t - lastPrint < interval) return;
      lastPrint = t;
      const short = label.length > 64 ? `…${label.slice(-63)}` : label;
      const size = bytes > 0 ? ` · ${humanSize(bytes)}` : '';
      line(`[${phase}] ${current}/${total}${size} ${short}`, final);
    },
  };
}
