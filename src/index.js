'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { filterFile } = require('./filter');

async function main() {
  const counts = await filterFile(process.env.INPUT_INPUT, process.env.INPUT_OUTPUT);
  console.log(`Original: ${counts.original}; removed: ${counts.removed}; retained: ${counts.retained}`);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set');
  const delimiter = `sarif_${randomUUID()}`;
  const outputs = Object.entries(counts)
    .map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`).join('');
  try {
    await fs.appendFile(process.env.GITHUB_OUTPUT, outputs, 'utf8');
  } catch (error) {
    throw new Error(`Unable to write action outputs: ${error.message}`);
  }
}

main().catch(error => {
  const message = error.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error::${message}`);
  process.exitCode = 1;
});
