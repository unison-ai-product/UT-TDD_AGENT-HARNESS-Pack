# UT-TDD thin Windows PowerShell entrypoint (ADR-001 / PLAN-L7-462 step 3).
# Prefer the compiled binary when present; otherwise run the TypeScript CLI through Node.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "dist\ut-tdd.exe"
if (Test-Path $bin) {
    & $bin @args
    exit $LASTEXITCODE
}
& node (Join-Path $root "src\cli.ts") @args
exit $LASTEXITCODE
