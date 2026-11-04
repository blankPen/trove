import ReactMarkdown from 'react-markdown';
import { highlight } from '../lib/highlight.ts';

/** 渲染记忆/SKILL.md 这类带 frontmatter 的 markdown,代码块按语言着色。 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            if (match) {
              // 块级代码:react-markdown 自己包 <pre>,这里只给着色后的 <code>
              return (
                <code
                  className="hljs"
                  dangerouslySetInnerHTML={{
                    __html: highlight(String(children).replace(/\n$/, ''), match[1]),
                  }}
                />
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {stripFrontmatter(text)}
      </ReactMarkdown>
    </div>
  );
}

/** 记忆文件带 frontmatter;正文部分才是 markdown。 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\n/, '');
}
