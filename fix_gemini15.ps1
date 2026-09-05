$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Find the exact pattern and add semicolon
$pattern = "      });\n      ws.send(JSON.stringify(setupMessage));"
$replacement = "      });\n      ws.send(JSON.stringify(setupMessage));"
$content = $content.Replace($pattern, $replacement)

$pattern2 = "      });\r\n      ws.send(JSON.stringify(setupMessage));"
$replacement2 = "      });\r\n      ws.send(JSON.stringify(setupMessage));"
$content = $content.Replace($pattern2, $replacement2)

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "\n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"