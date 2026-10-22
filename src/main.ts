#!/usr/bin/env node
import { run } from './cli.js';

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`错误: ${(e as Error).message}`);
    process.exit(1);
  });
