#!/usr/bin/env bash
set -euo pipefail

echo "================================================================="
echo "   Code Insights Reporting Skill - Automated Verification Suite  "
echo "================================================================="

GLOBAL_SKILL_DIR="$HOME/.gemini/skills/code-insights-reports"
REPO_SKILL_DIR="$(pwd)/.agents/skills/code-insights-reports"
DB_PATH="$HOME/.code-insights/data.db"
RUNNER="$GLOBAL_SKILL_DIR/scripts/ci-report.js"
TEMP_DIR="$(mktemp -d /tmp/ci-verify-XXXXXX)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "1. Checking directory scaffolding and file existence..."
for dir in "$GLOBAL_SKILL_DIR" "$REPO_SKILL_DIR"; do
  [[ -f "$dir/SKILL.md" ]] || { echo "ERROR: Missing $dir/SKILL.md"; exit 1; }
  [[ -x "$dir/scripts/ci-report.js" ]] || { echo "ERROR: Missing executable $dir/scripts/ci-report.js"; exit 1; }
  [[ -f "$dir/references/schema-v18.md" ]] || { echo "ERROR: Missing $dir/references/schema-v18.md"; exit 1; }
  [[ -f "$dir/references/sql-recipes.md" ]] || { echo "ERROR: Missing $dir/references/sql-recipes.md"; exit 1; }
done
echo "   ✓ All files exist in both global and repo directories."

echo "2. Checking parity between global and repository skill packages..."
diff -r "$GLOBAL_SKILL_DIR" "$REPO_SKILL_DIR"
echo "   ✓ Global and repository directories are identical."

echo "3. Capturing initial database modification timestamp..."
[[ -f "$DB_PATH" ]] || { echo "ERROR: Database not found at $DB_PATH"; exit 1; }
INITIAL_MTIME="$(stat -c %Y "$DB_PATH")"
INITIAL_SIZE="$(stat -c %s "$DB_PATH")"
echo "   ✓ DB MTIME: $INITIAL_MTIME, Size: $INITIAL_SIZE bytes"

echo "4. Running built-in runner self-test (ci-report.js verify)..."
node "$RUNNER" verify
echo "   ✓ Built-in self-test passed."

echo "5. Testing all analytical subcommands in markdown format..."
echo "   - Testing 'summary'..."
node "$RUNNER" summary > "$TEMP_DIR/summary.md"
grep -q "Total Sessions" "$TEMP_DIR/summary.md"
grep -q "Activity by AI Coding Tool" "$TEMP_DIR/summary.md"

echo "   - Testing 'reflection'..."
node "$RUNNER" reflection --days 30 --limit 5 > "$TEMP_DIR/reflection.md"
grep -q "Session Reflection & Developer Digest" "$TEMP_DIR/reflection.md"
grep -q "Recent Coding Sessions" "$TEMP_DIR/reflection.md"

echo "   - Testing 'cost'..."
node "$RUNNER" cost --days 30 > "$TEMP_DIR/cost.md"
grep -q "Token Economics & Cost Report" "$TEMP_DIR/cost.md"
grep -q "Economics by AI Coding Tool" "$TEMP_DIR/cost.md"

echo "   - Testing 'friction'..."
node "$RUNNER" friction --days 30 --limit 5 > "$TEMP_DIR/friction.md"
grep -q "Friction & Failure Loops Analysis" "$TEMP_DIR/friction.md"
grep -q "Friction Taxonomy & Attribution Breakdown" "$TEMP_DIR/friction.md"

echo "   - Testing 'prompt-quality'..."
node "$RUNNER" prompt-quality --limit 5 > "$TEMP_DIR/prompt-quality.md"
grep -q "Prompt Quality & SFL Analysis Report" "$TEMP_DIR/prompt-quality.md"
grep -q "SFL Metafunction Dimension Scores" "$TEMP_DIR/prompt-quality.md"

echo "   - Testing 'benchmarks'..."
node "$RUNNER" benchmarks --days 30 > "$TEMP_DIR/benchmarks.md"
grep -q "Cross-Tool Coding Agent Benchmarks" "$TEMP_DIR/benchmarks.md"
grep -q "Tool Name" "$TEMP_DIR/benchmarks.md"

echo "   - Testing 'timeline' with Mermaid causal trace..."
node "$RUNNER" timeline --limit 5 --mermaid > "$TEMP_DIR/timeline.md"
grep -q "Architectural Decision Records (ADR)" "$TEMP_DIR/timeline.md"
grep -q "flowchart TD" "$TEMP_DIR/timeline.md"

echo "   ✓ All subcommands generated well-formed Markdown."

echo "6. Testing JSON export (--json)..."
node "$RUNNER" summary --json > "$TEMP_DIR/summary.json"
node -e "const data = JSON.parse(require('fs').readFileSync('$TEMP_DIR/summary.json')); if (!data.globalStats || !data.toolStats) process.exit(1);"
echo "   ✓ Valid JSON output verified."

echo "7. Testing file output flag (--output)..."
node "$RUNNER" cost --days 7 --output "$TEMP_DIR/exported-cost.md" > /dev/null
[[ -f "$TEMP_DIR/exported-cost.md" ]]
grep -q "Token Economics & Cost Report" "$TEMP_DIR/exported-cost.md"
echo "   ✓ File output flag (--output) verified."

echo "8. Testing ad-hoc read-only query and safety guards..."
# Valid query
node "$RUNNER" query "SELECT name, session_count FROM projects ORDER BY session_count DESC LIMIT 3" > "$TEMP_DIR/query.md"
grep -q "session_count" "$TEMP_DIR/query.md"

# Mutative query rejection
set +e
node "$RUNNER" query "INSERT INTO sessions (id) VALUES ('fail')" 2> "$TEMP_DIR/err.txt"
ERR_CODE=$?
set -e
if [[ $ERR_CODE -eq 0 ]]; then
  echo "ERROR: Unsafe INSERT query was NOT blocked!"
  exit 1
fi
grep -q "Unsafe query rejected" "$TEMP_DIR/err.txt"
echo "   ✓ Ad-hoc query runner safely executed SELECT and blocked mutative statements."

echo "9. Verifying database read-only integrity (zero file modifications)..."
POST_MTIME="$(stat -c %Y "$DB_PATH")"
POST_SIZE="$(stat -c %s "$DB_PATH")"

if [[ "$INITIAL_MTIME" -ne "$POST_MTIME" ]]; then
  echo "ERROR: Database mtime modified! Initial: $INITIAL_MTIME, Post: $POST_MTIME"
  exit 1
fi

if [[ "$INITIAL_SIZE" -ne "$POST_SIZE" ]]; then
  echo "ERROR: Database file size modified! Initial: $INITIAL_SIZE, Post: $POST_SIZE"
  exit 1
fi
echo "   ✓ Database file mtime and byte size preserved exactly (100% read-only integrity)."

echo "================================================================="
echo "   ALL VERIFICATION SUITE CHECKS PASSED (EXIT CODE 0)            "
echo "================================================================="
