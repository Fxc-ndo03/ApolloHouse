$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Add semicolons after all }); that are followed by whitespace and a non-whitespace character
$content = $content -replace '  \}\);\s+(?=\S)', '  });; '

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "\n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"