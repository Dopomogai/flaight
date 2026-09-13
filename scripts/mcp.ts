import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createObserver } from '../lib/public/mcp';

await createObserver(resolve(process.argv[2] ?? 'runs')).connect(new StdioServerTransport());
