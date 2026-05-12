param(
  [string]$SessionPath = ".agent-diff-review/session.json",
  [string]$ReportPath = ".agent-diff-review/report.html"
)

$ErrorActionPreference = "Stop"
adr scan --format json --out $SessionPath
adr report --session $SessionPath --out $ReportPath
Write-Output "agent-diff-review report written to $ReportPath"

