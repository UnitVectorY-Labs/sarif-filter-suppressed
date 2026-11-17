'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireStructure(condition, location, expected) {
  if (!condition) throw new Error(`Invalid SARIF structure: ${location} must be ${expected}`);
}

function validate(report) {
  requireStructure(object(report), 'report', 'an object');
  if (report.version !== '2.1.0') {
    throw new Error('Unsupported SARIF version: expected "2.1.0"');
  }
  requireStructure(Array.isArray(report.runs), 'runs', 'an array');
  report.runs.forEach((run, runIndex) => {
    const location = `runs[${runIndex}]`;
    requireStructure(object(run), location, 'an object');
    requireStructure(object(run.tool) && object(run.tool.driver) &&
      typeof run.tool.driver.name === 'string' && run.tool.driver.name.length > 0,
    `${location}.tool.driver.name`, 'a nonempty string');
    if (!Object.hasOwn(run, 'results')) return;
    requireStructure(Array.isArray(run.results), `${location}.results`, 'an array');
    run.results.forEach((result, resultIndex) => {
      const at = `${location}.results[${resultIndex}]`;
      requireStructure(object(result), at, 'an object');
      requireStructure(object(result.message) &&
        ['text', 'id'].some(key => typeof result.message[key] === 'string'),
      `${at}.message`, 'an object with a text or id string');
      if (!Object.hasOwn(result, 'suppressions')) return;
      requireStructure(Array.isArray(result.suppressions), `${at}.suppressions`, 'an array');
      result.suppressions.forEach((suppression, suppressionIndex) => {
        const entry = `${at}.suppressions[${suppressionIndex}]`;
        requireStructure(object(suppression), entry, 'an object');
        requireStructure(['inSource', 'external'].includes(suppression.kind),
          `${entry}.kind`, '"inSource" or "external"');
        requireStructure(!Object.hasOwn(suppression, 'status') ||
          ['accepted', 'rejected', 'underReview'].includes(suppression.status),
        `${entry}.status`, '"accepted", "rejected", or "underReview" when present');
      });
    });
  });
}

async function filterFile(input, output) {
  for (const [name, value] of Object.entries({ input, output })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Required input "${name}" must be a nonempty file path`);
    }
  }
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  const sameFile = () => new Error('Input and output paths must not resolve to the same file');
  if (inputPath === outputPath) throw sameFile();

  let source;
  let inputRealPath;
  try {
    inputRealPath = await fs.realpath(inputPath);
    source = await fs.readFile(inputPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read input "${inputPath}": ${error.message}`);
  }

  try {
    const [outputRealPath, inputStat, outputStat] = await Promise.all([
      fs.realpath(outputPath), fs.stat(inputPath), fs.stat(outputPath)
    ]);
    if (inputRealPath === outputRealPath ||
        (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino)) {
      throw sameFile();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let report;
  try {
    // Keep numeric tokens intact, including values beyond JavaScript's precision.
    report = JSON.parse(source, (key, value, context) =>
      typeof value === 'number' ? JSON.rawJSON(context.source) : value);
  } catch (error) {
    throw new Error(`Malformed JSON in input "${inputPath}": ${error.message}`);
  }
  validate(report);

  let original = 0;
  let retained = 0;
  for (const run of report.runs) {
    if (!Object.hasOwn(run, 'results')) continue;
    original += run.results.length;
    run.results = run.results.filter(result => !result.suppressions?.some(suppression =>
      !Object.hasOwn(suppression, 'status') || suppression.status === 'accepted'));
    retained += run.results.length;
  }

  try {
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new Error(`Unable to write output "${outputPath}": ${error.message}`);
  }
  return { original, removed: original - retained, retained, output: outputPath };
}

module.exports = { filterFile };
