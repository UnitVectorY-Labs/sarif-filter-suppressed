'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { filterFile } = require('../src/filter');

const finding = suppressions => ({
  message: { text: 'A finding' },
  ...(suppressions === undefined ? {} : { suppressions })
});
const run = results => ({ tool: { driver: { name: 'scanner' } }, results });
const report = results => ({ version: '2.1.0', runs: [run(results)] });

async function files(t, content = report([])) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sarif-filter-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'original.sarif');
  const output = path.join(directory, 'filtered.sarif');
  await fs.writeFile(input, typeof content === 'string' ? content : JSON.stringify(content));
  return { directory, input, output };
}

for (const kind of ['inSource', 'external']) {
  for (const status of [undefined, 'accepted', 'rejected', 'underReview']) {
    test(`${kind}: ${status ?? 'omitted status'}`, async t => {
      const suppression = { kind, ...(status === undefined ? {} : { status }) };
      const { input, output } = await files(t, report([finding([suppression])]));
      const removed = status === undefined || status === 'accepted' ? 1 : 0;
      assert.deepEqual(await filterFile(input, output), {
        original: 1, removed, retained: 1 - removed, output
      });
      assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).runs[0].results.length, 1 - removed);
    });
  }
}

test('any accepted or omitted status removes a result, regardless of suppression order', async t => {
  const rejected = { kind: 'inSource', status: 'rejected' };
  const review = { kind: 'external', status: 'underReview' };
  const accepted = { kind: 'external', status: 'accepted' };
  const omitted = { kind: 'inSource' };
  const results = [
    finding([rejected, review]), finding(), finding([]),
    finding([rejected, accepted]), finding([accepted, review]),
    finding([review, omitted]), finding([omitted, rejected])
  ];
  const { input, output } = await files(t, report(results));
  assert.deepEqual(await filterFile(input, output), { original: 7, removed: 4, retained: 3, output });
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')).runs[0].results, results.slice(0, 3));
});

test('processes every run and preserves all other content and indices', async t => {
  const keep = {
    ...finding([{ kind: 'external', status: 'rejected', justification: 'Investigate' }]),
    ruleId: 'rule-b', ruleIndex: 1, level: 'warning',
    locations: [{ physicalLocation: { artifactLocation: { index: 1 }, region: { startLine: 8 } } }],
    fingerprints: { primary: 'abc' }, properties: { custom: ['雪', false, null] }
  };
  const original = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    inlineExternalProperties: [], properties: { custom: 'unchanged' },
    runs: [
      {
        ...run([finding([{ kind: 'inSource' }]), keep]),
        tool: { driver: { name: 'scanner', rules: [{ id: 'rule-a' }, { id: 'rule-b' }] } },
        artifacts: [{ location: { uri: 'a.js' } }, { location: { uri: 'b.js' } }],
        invocations: [{ executionSuccessful: true }], automationDetails: { id: 'scan/' }
      },
      run([finding(), finding([{ kind: 'external', status: 'accepted' }])]),
      run([]), { tool: { driver: { name: 'metadata-only' } } }
    ]
  };
  const { input, output } = await files(t, original);
  const inputBytes = await fs.readFile(input);
  assert.deepEqual(await filterFile(input, output), { original: 4, removed: 2, retained: 2, output });
  const expected = structuredClone(original);
  expected.runs[0].results = [keep];
  expected.runs[1].results = [finding()];
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), expected);
  assert.deepEqual(await fs.readFile(input), inputBytes);
});

test('preserves numeric tokens without precision loss', async t => {
  const source = '{"version":"2.1.0","runs":[],"properties":{"integer":9007199254740993,"decimal":0.1234567890123456789,"large":1e400,"negativeZero":-0}}';
  const { input, output } = await files(t, source);
  await filterFile(input, output);
  const result = await fs.readFile(output, 'utf8');
  for (const token of ['9007199254740993', '0.1234567890123456789', '1e400', '-0']) {
    assert.ok(result.includes(token));
  }
});

for (const document of [{ version: '2.1.0', runs: [] }, report([])]) {
  test(`empty ${document.runs.length ? 'results' : 'runs'} produces zero counts`, async t => {
    const { input, output } = await files(t, document);
    assert.deepEqual(await filterFile(input, output), { original: 0, removed: 0, retained: 0, output });
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), document);
  });
}

test('resolves relative paths from the working directory', async t => {
  const { input, output } = await files(t);
  const counts = await filterFile(path.relative(process.cwd(), input), path.relative(process.cwd(), output));
  assert.equal(counts.output, output);
});

test('rejects identical and normalized paths without modifying input', async t => {
  const { input, directory } = await files(t);
  const before = await fs.readFile(input);
  for (const output of [input, path.join(directory, 'child', '..', 'original.sarif')]) {
    await assert.rejects(filterFile(input, output), /same file/);
  }
  assert.deepEqual(await fs.readFile(input), before);
});

for (const kind of ['symlink', 'hard link']) {
  test(`rejects a ${kind} alias without modifying input`, async t => {
    const { input, output } = await files(t);
    const before = await fs.readFile(input);
    // Windows file symlinks can require Developer Mode or elevated privileges.
    try {
      if (kind === 'symlink') await fs.symlink(input, output);
      else await fs.link(input, output);
    } catch (error) {
      if (kind === 'symlink' && process.platform === 'win32' && error.code === 'EPERM') {
        t.skip('File symlinks require Windows privileges');
        return;
      }
      throw error;
    }
    await assert.rejects(filterFile(input, output), /same file/);
    assert.deepEqual(await fs.readFile(input), before);
  });
}

for (const [label, content, pattern] of [
  ['malformed JSON', '{', /Malformed JSON/],
  ['unsupported version', { version: '2.0.0', runs: [] }, /Unsupported SARIF version/],
  ['missing version', { runs: [] }, /Unsupported SARIF version/],
  ['null report', 'null', /report must be an object/],
  ['array report', '[]', /report must be an object/],
  ['missing runs', { version: '2.1.0' }, /runs must be an array/],
  ['invalid runs', { version: '2.1.0', runs: {} }, /runs must be an array/],
  ['null run', { version: '2.1.0', runs: [null] }, /runs\[0\] must be an object/],
  ['missing tool', { version: '2.1.0', runs: [{}] }, /tool.driver.name/],
  ['missing driver', { version: '2.1.0', runs: [{ tool: {} }] }, /tool.driver.name/],
  ['empty driver name', { version: '2.1.0', runs: [{ tool: { driver: { name: '' } } }] }, /tool.driver.name/],
  ['null results', report(null), /results must be an array/],
  ['object results', report({}), /results must be an array/],
  ['null result', report([null]), /results\[0\] must be an object/],
  ['missing message', report([{}]), /message/],
  ['invalid message', report([{ message: 'text' }]), /message/],
  ['null suppressions', report([finding(null)]), /suppressions must be an array/],
  ['object suppressions', report([finding({})]), /suppressions must be an array/],
  ['null suppression', report([finding([null])]), /suppressions\[0\] must be an object/],
  ['missing kind', report([finding([{}])]), /kind/],
  ['invalid kind', report([finding([{ kind: 'other' }])]), /kind/],
  ['invalid status', report([finding([{ kind: 'external', status: 'unknown' }])]), /status/],
  ['null status', report([finding([{ kind: 'external', status: null }])]), /status/],
  ['invalid suppression after accepted', report([finding([{ kind: 'external' }, null])]), /suppressions\[1\]/]
]) {
  test(`fails for ${label} without replacing existing output`, async t => {
    const { input, output } = await files(t, content);
    await fs.writeFile(output, 'existing output');
    await assert.rejects(filterFile(input, output), pattern);
    assert.equal(await fs.readFile(output, 'utf8'), 'existing output');
  });
}

test('validates later runs before writing output', async t => {
  const { input, output } = await files(t, {
    version: '2.1.0', runs: [run([finding([{ kind: 'external' }])]), run(null)]
  });
  await assert.rejects(filterFile(input, output), /runs\[1\].results/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('requires both nonempty paths', async t => {
  const { input, output } = await files(t);
  for (const value of [undefined, '', '  ']) {
    await assert.rejects(filterFile(value, output), /Required input "input"/);
    await assert.rejects(filterFile(input, value), /Required input "output"/);
  }
});

test('reports unreadable input and output write failures', async t => {
  const { input, output, directory } = await files(t);
  await assert.rejects(filterFile(path.join(directory, 'missing'), output), /Unable to read input/);
  await assert.rejects(filterFile(directory, output), /Unable to read input/);
  await assert.rejects(filterFile(input, path.join(directory, 'missing', 'output')), /Unable to write output/);
  await assert.rejects(filterFile(input, directory), /Unable to write output/);
});

function action(input, output, githubOutput) {
  const env = { ...process.env, INPUT_INPUT: input, INPUT_OUTPUT: output };
  delete env.GITHUB_OUTPUT;
  if (githubOutput !== undefined) env.GITHUB_OUTPUT = githubOutput;
  return spawnSync(process.execPath, [path.resolve(__dirname, '../src/index.js')], {
    env, encoding: 'utf8'
  });
}

test('action entry point logs counts and exposes all outputs', async t => {
  const { input, output, directory } = await files(t, report([
    finding(), finding([{ kind: 'inSource' }])
  ]));
  const outputFile = path.join(directory, 'github-output');
  const result = action(input, output, outputFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Original: 2; removed: 1; retained: 1/);
  const entries = (await fs.readFile(outputFile, 'utf8')).trimEnd().split('\n');
  const actual = {};
  for (let index = 0; index < entries.length; index += 3) {
    const [name, delimiter] = entries[index].split('<<');
    assert.equal(entries[index + 2], delimiter);
    actual[name] = entries[index + 1];
  }
  assert.deepEqual(actual, { original: '2', removed: '1', retained: '1', output });
});

test('action entry point fails clearly for missing input and runner output errors', async t => {
  const { input, output, directory } = await files(t);
  for (const [result, expected] of [
    [action('', output), /Required input "input"/],
    [action(input, ''), /Required input "output"/],
    [action(input, output), /GITHUB_OUTPUT is not set/],
    [action(input, output, directory), /Unable to write action outputs/]
  ]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::/);
    assert.match(result.stderr, expected);
  }
});

test('escapes error messages so file paths cannot inject runner commands', async t => {
  const { output, directory } = await files(t);
  const input = path.join(directory, 'missing%file\n::warning::unexpected');
  const result = action(input, output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing%25file%0A::warning::unexpected/);
  assert.equal(result.stderr.trimEnd().split('\n').length, 1);
});
