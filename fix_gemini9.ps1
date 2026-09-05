$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Fix line 296: change "    };" to "    });"
$content = $content.Replace("    };", "    });")

# Remove stray semicolon (line with just "  ;")
$content = $content.Replace("  ;`n", "`n")

# Remove extra }); at the end
$content = $content.Replace("  });`n  });", "  });")

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"