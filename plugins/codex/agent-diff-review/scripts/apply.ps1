param(
  [string]$SessionPath = ".agent-diff-review/session.json",
  [string]$DecisionPath = ".agent-diff-review/decisions.json",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$argsList = @("apply", "--session", $SessionPath, "--decisions", $DecisionPath)
if ($DryRun) {
  $argsList += "--dry-run"
}
node "$PSScriptRoot/adr-wrapper.mjs" @argsList
