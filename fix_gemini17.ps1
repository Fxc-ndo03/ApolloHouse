$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Fix the double semicolons and broken lines
$content = $content.Replace("});; ", "});\n")
$content = $content -replace '}\);;\s*', '});\n'

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "\n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"