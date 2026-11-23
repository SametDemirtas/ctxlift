
// `testing/` and `spec/` are deliberately absent: packages ship source modules under those names
export const TEST_PATH =
  /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;

const CODE_EXT = /\.(py|[cm]?[jt]sx?)$/;

export const NON_PRODUCT_PATH = /(^|\/)(docs?|docs_src|examples?|\.github|benchmarks?)\//;

export const DEPENDENCY_FILE =
  /(^|\/)([^/]+\.lock|package-lock\.json|pnpm-lock\.yaml|package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.(py|cfg)|Pipfile|uv\.toml|\.python-version|\.nvmrc)$/;

// a PR that changes one outside its test files can't be graded fairly, so it is skipped
export const TEST_CONFIG_FILE =
  /(^|\/)(pytest\.ini|\.pytest\.ini|pytest\.toml|\.pytest\.toml|tox\.ini|sitecustomize\.py|(vitest|jest)\.config\.[cm]?[jt]s)$/;

export const isTestFile = (p: string): boolean => TEST_PATH.test(p);
export const isProductCode = (p: string): boolean => CODE_EXT.test(p) && !NON_PRODUCT_PATH.test(p) && !TEST_PATH.test(p);

export const isGradingEnvironment = (p: string): boolean => TEST_PATH.test(p) || TEST_CONFIG_FILE.test(p) || DEPENDENCY_FILE.test(p);
