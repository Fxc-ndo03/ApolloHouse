$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Remove stray semicolon
$content = $content.Replace("  ;`n", "`n")

# Fix double closing });
$content = $content.Replace("  });\r\n  });", "  });")

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"