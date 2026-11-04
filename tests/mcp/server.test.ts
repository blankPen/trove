import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';

async function fixture(): Promise<{ vault: string; cacheDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'trove-mcp-'));
  const vault = join(base, 'vault');
  const dir = join(vault, 'library/lessons/preferences');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'profile.md'),
    [
      '---',
      'type: preferences/profile',
      'title: "阿振"',
      'tags: ["preferences","profile"]',
      'updated_at: "2026-11-03T10:00:00Z"',
      '---',
      '',
      '### 我是谁',
      '阿振，研发四部 TL。',
      '',
    ].join('\n'),
  );
  return { vault, cacheDir: join(base, 'cache') };
}

let client: Client | undefined;
let server: ReturnType<typeof createMcpServer> | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

describe('trove MCP server', () => {
  it('注册 7 个工具，并能调用 whoami 与 lessons_search', async () => {
    const { vault, cacheDir } = await fixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createMcpServer({ vault, cacheDir, version: 'test' });
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'trove_lesson_get',
      'trove_lessons_list',
      'trove_lessons_search',
      'trove_session_get',
      'trove_sessions_search',
      'trove_status',
      'trove_whoami',
    ]);

    const who = await client.callTool({ name: 'trove_whoami', arguments: {} });
    expect((who.content as Array<{ text: string }>)[0]?.text).toContain('阿振');

    const status = await client.callTool({ name: 'trove_status', arguments: {} });
    expect((status.content as Array<{ text: string }>)[0]?.text).toContain('经验/记忆');
  });
});
