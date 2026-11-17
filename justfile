set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Show available recipes.
default:
  @just --list

# Install dependencies exactly as locked.
install:
  npm ci

# Quick local validation for source syntax.
lint:
  npm run lint

# Run the built-in Node.js test suite.
test:
  npm test
