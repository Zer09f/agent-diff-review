param(
  [string]$SessionPath = ".agent-diff-review/session.json",
  [string]$ReportPath = ".agent-diff-review/report.html"
)

$ErrorActionPreference = "Stop"
node "$PSScriptRoot/adr-wrapper.mjs" scan --format json --out $SessionPath
node "$PSScriptRoot/adr-wrapper.mjs" report --session $SessionPath --out $ReportPath
Write-Output "agent-diff-review report written to $ReportPath"
