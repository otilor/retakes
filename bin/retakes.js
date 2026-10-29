#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`Retakes needs Node.js 18.17 or newer. You have ${process.versions.node}.`);
  process.exit(1);
}

const { main } = await import('../src/cli.js');
await main(process.argv.slice(2));
