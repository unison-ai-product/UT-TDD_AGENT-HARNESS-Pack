# UT-TDD thin Windows PowerShell entrypoint (ADR-001).
# Prefer the compiled binary when present; otherwise run the TypeScript CLI through Bun.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "dist\ut-tdd.exe"
if (Test-Path $bin) {
    & $bin @args
    exit $LASTEXITCODE
}
& bun run (Join-Path $root "src\cli.ts") @args
exit $LASTEXITCODE
