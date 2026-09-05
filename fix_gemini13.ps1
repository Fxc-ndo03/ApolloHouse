$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Add semicolon after }); before ws.send
$content = $content.Replace("      });\n      ws.send", "      });\n      ws.send")

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"