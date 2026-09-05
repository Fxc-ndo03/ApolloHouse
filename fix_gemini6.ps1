$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Fix the double closing });
$content = $content -replace '  \}\)\);', '  });'

# Fix any remaining double closures
$content = $content -replace '  \}\)\;', '  });'

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"