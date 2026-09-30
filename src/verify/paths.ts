/**
 * Path classification and validation for pull request test files. Every path taken from a pull request or
 * from Devin's structured output is data: it is validated here before anything runs, and is only ever
 * passed to the administrator's test runner as a separate argument, never through a shell.
 */

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+@=-]*$/;
const MAX_PATH_LENGTH = 300;

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing']);
const TEST_FILE = [
  /\.(test|spec)\.[A-Za-z0-9]+$/,
  /^test_[^/]+\.py$/,
  /_test\.(py|go|rb|exs?)$/,
  /_tests\.py$/,
  /_spec\.rb$/,
  /Tests?\.(java|kt|cs|swift)$/,
];

/** Test, lint, type-check and CI configuration; changing any of it changes the rules the proof runs under. */
const CONFIG_FILE = [
  /^pytest\.ini$/,
  /^conftest\.py$/,
  /^tox\.ini$/,
  /^noxfile\.py$/,
  /^setup\.cfg$/,
  /^\.coveragerc$/,
  /^\.flake8$/,
  /^mypy\.ini$/,
  /^\.mypy\.ini$/,
  /^\.?pylintrc$/,
  /^\.?ruff\.toml$/,
  /^\.eslintrc(\.[A-Za-z]+)?$/,
  /^\.eslintignore$/,
  /^eslint\.config\.[A-Za-z]+$/,
  /^\.prettierrc(\.[A-Za-z]+)?$/,
  /^biome\.jsonc?$/,
  /^tsconfig(\.[A-Za-z0-9-]+)?\.json$/,
  /^(jest|vitest|vite|karma|playwright|cypress|ava|babel)\.config\.[A-Za-z]+$/,
  /^\.mocharc(\.[A-Za-z]+)?$/,
  /^\.nycrc(\.[A-Za-z]+)?$/,
  /^\.golangci\.ya?ml$/,
  /^\.rubocop\.yml$/,
  /^\.rspec$/,
  /^phpunit\.xml(\.dist)?$/,
  /^\.gitlab-ci\.yml$/,
  /^\.travis\.yml$/,
  /^azure-pipelines\.ya?ml$/,
  /^Jenkinsfile$/,
];
const CONFIG_DIRECTORY = [/^\.github\/workflows\//, /^\.circleci\//, /^\.buildkite\//];

function segments(path: string): string[] {
  return path.split('/');
}

export function isConfigPath(path: string): boolean {
  if (CONFIG_DIRECTORY.some((pattern) => pattern.test(path))) return true;
  const name = segments(path).at(-1) ?? '';
  return CONFIG_FILE.some((pattern) => pattern.test(name));
}

/** A test file or test support file (fixtures, helpers) by location or name; configuration is never a test. */
export function isTestPath(path: string): boolean {
  if (isConfigPath(path)) return false;
  const parts = segments(path);
  const name = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((part) => TEST_DIRECTORIES.has(part.toLowerCase()))) return true;
  return TEST_FILE.some((pattern) => pattern.test(name));
}

/** Data files are fixtures even when named like a test (`payload.test.json`). */
const DATA_FILE = /\.(json5?|jsonc|ya?ml|toml|xml|csv|tsv|txt|md|html?|snap|svg|png|jpe?g|gif)$/i;

/** A test file the runner can run, by name; fixtures and helpers under a test directory are not. */
export function isRunnableTestPath(path: string): boolean {
  if (isConfigPath(path)) return false;
  const name = segments(path).at(-1) ?? '';
  if (DATA_FILE.test(name)) return false;
  return TEST_FILE.some((pattern) => pattern.test(name));
}

/** Why a selected test path is refused, or `null` when it is a plain relative file path inside the repository. */
export function testPathProblem(path: string): string | null {
  if (typeof path !== 'string' || path === '') return 'is empty';
  if (path.length > MAX_PATH_LENGTH) return `is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('~')) return 'is not relative to the repository';
  const parts = segments(path);
  if (parts.some((part) => part === '..')) return 'contains path traversal (..)';
  if (parts.some((part) => part === '' || part === '.')) return 'is not a normalized path';
  if (parts.some((part) => part.toLowerCase() === '.git')) return 'points into .git';
  if (path.startsWith('-')) return 'looks like a command-line option';
  if (/[*?[\]{}]/.test(path)) return 'contains a glob pattern (unsupported way of selecting tests)';
  if (path.includes('::')) return 'contains a test selector (unsupported way of selecting tests)';
  if (/[;&|`$<>()\\'"!#\s]/.test(path)) return 'contains shell metacharacters or whitespace';
  if (!parts.every((part) => SEGMENT.test(part))) return 'contains unsupported characters';
  return null;
}

export interface PathRejection {
  path: string;
  problem: string;
}

export function validateTestPaths(paths: readonly string[]): PathRejection[] {
  const rejections: PathRejection[] = [];
  for (const path of paths) {
    const problem = testPathProblem(path);
    if (problem !== null) rejections.push({ path, problem });
  }
  return rejections;
}
