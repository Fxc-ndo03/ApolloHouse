$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Replace literal \r\n with actual newlines
$content = $content.Replace("\r\n", "`n")

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"