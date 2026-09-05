$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Simple string replace for the double closing });
$content = $content.Replace("  }););", "  });")

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"