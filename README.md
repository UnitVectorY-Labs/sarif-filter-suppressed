[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![Active](https://img.shields.io/badge/Status-Active-green)](https://guide.unitvectorylabs.com/bestpractices/status/#active)

# sarif-filter-suppressed

Reusable GitHub Action that removes suppressed findings from SARIF 2.1.0 reports before upload to consumers that do not honor suppression markers.

Runs locally using Node.js 24, plain JavaScript, and Node built-ins. No dependencies, compilation, bundling, container, network calls, credentials, or GitHub API access are needed by this action.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `input` | Yes | Path to the original SARIF 2.1.0 report. |
| `output` | Yes | Path to write the filtered report. Must resolve to a different file from `input`. |

Relative paths resolve from the job's working directory. The output parent directory must already exist. An existing output file is overwritten; the original input is preserved. Equivalent paths, symlinks, and hard links to the input are rejected.

## Outputs

| Output | Description |
| --- | --- |
| `original` | Total number of results in all original runs. |
| `removed` | Number of suppressed results removed. |
| `retained` | Number of results retained across all runs. |
| `output` | Absolute path to the filtered report. |

Counts are also logged. GitHub Actions exposes output values as strings.

## Suppression semantics

Every result in every run is examined. Both `inSource` and `external` suppression kinds use the same policy:

| Suppression status | Effect |
| --- | --- |
| `accepted` | Remove the result. |
| Omitted | Remove the result. |
| `rejected` | Retain unless another suppression removes it. |
| `underReview` | Retain unless another suppression removes it. |

Any accepted suppression or suppression without a status removes the whole result, even if other entries are rejected or under review. Results without suppressions or with an empty suppression array are retained.

Only matching entries in `runs[*].results` are removed. All other content is preserved semantically, including retained result fields, suppressions, rules, artifacts, metadata, and indices. Rules are never pruned and indices are never rewritten. JSON whitespace is reformatted; numeric tokens retain their original precision. Empty runs and results are supported. Metadata-only runs that omit `results` remain unchanged.

The action fails with a clear error for missing inputs, identical input/output files, unreadable input, malformed JSON, versions other than `2.1.0`, invalid required structure, and output write failures. Structural checks cover the report, runs, tool driver names, result messages, and suppression kinds/statuses; this is not a full SARIF schema validator. Validation completes before the output is written.

These fields follow the [SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).

## Usage

Place the filter between Semgrep SARIF generation and `github/codeql-action/upload-sarif`. This example uses `main` because no release has been published; pin the filter to a reviewed commit SHA for reproducible workflows.

```yaml
name: Semgrep

on:
  push:
    branches:
      - main
  pull_request:

permissions:
  contents: read
  security-events: write

jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Install uv
        uses: astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3

      - name: Generate Semgrep SARIF
        run: uvx --from semgrep==1.172.0 semgrep scan --config auto --sarif --output semgrep.sarif

      - name: Remove suppressed findings
        id: filter
        uses: UnitVectorY-Labs/sarif-filter-suppressed@main
        with:
          input: semgrep.sarif
          output: semgrep.filtered.sarif

      - name: Upload filtered findings
        uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        with:
          sarif_file: ${{ steps.filter.outputs.output }}
          category: semgrep
```

Semgrep generation and SARIF upload use their own network access and permissions. The filtering step only reads and writes local files and requires no token or permissions.

## Development

Use Node.js 24 or newer:

```sh
npm ci
npm run lint
npm test
```

Tests use Node's built-in test runner and cover suppression statuses and kinds, multiple suppressions and runs, empty reports, content preservation, file aliases, errors, and action outputs. CI runs them on Linux, Windows, and macOS with Node.js 24.

Repository maintenance and security workflows, Dependabot configuration, `.gitignore`, `.clip4llm`, and the MIT license are copied from `kuberollouttrigger-action`. Its bundle-specific `check-dist` workflow is replaced by the test matrix because this action executes source directly.
