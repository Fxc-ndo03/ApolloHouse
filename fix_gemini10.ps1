$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Add semicolon after }); at line 122 (after setupMessage send)
$content = $content.Replace("      });\r\n      ws.send", "      });\r\n      ws.send")

# Also fix any other missing semicolons after });
$content = $content -replace '  \}\);\r\n      ws\.', '  });\r\n      ws.'

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"