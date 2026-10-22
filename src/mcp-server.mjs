// MCP server: exposes the local model as a tool to LLM agents.
// Same transport pattern as @stanzaapi/mcp (stdio + HTTP/SSE).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LLAMA = process.env.LLAMA_URL || 'http://127.0.0.1:8081';

const server = new McpServer({
  name: 'local-inference',
  version: '0.1.0',
});

server.tool(
  'complete',
  'Run a completion against the local model. Returns the generated text.',
  {
    prompt: z.string().describe('The prompt to complete'),
    max_tokens: z.number().optional().describe('Max tokens to generate (default 256)'),
    temperature: z.number().optional().describe('Sampling temperature (default 0.7)'),
  },
  async ({ prompt, max_tokens = 256, temperature = 0.7 }) => {
    const res = await fetch(`${LLAMA}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: prompt }],
        max_tokens,
        temperature,
      }),
    });
    if (!res.ok) return { content: [{ type: 'text', text: `error: ${res.status}` }] };
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'health',
  'Check whether the local inference backend is reachable.',
  {},
  async () => {
    try {
      const res = await fetch(`${LLAMA}/v1/models`, { signal: AbortSignal.timeout(3000) });
      return { content: [{ type: 'text', text: res.ok ? 'backend reachable' : `backend returned ${res.status}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `backend unreachable: ${err.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('local-inference MCP server running (stdio)');
EOF
echo "mcp server written (needs @modelcontextprotocol/sdk)"