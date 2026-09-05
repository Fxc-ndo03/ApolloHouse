$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw
# Find the extra });
$pattern = '  };\r?\n\s*  try {'
$replacement = '  try {'
$newContent = $content -replace $pattern, $replacement
Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $newContent -Encoding UTF8
Write-Host "Done"