$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Find the await setupPromise line
$setupAwaitIdx = $content.IndexOf("await setupPromise;")
if ($setupAwaitIdx -gt 0) {
    # Insert }); before await setupPromise
    $content = $content.Insert($setupAwaitIdx, "  });`n")
    Write-Host "Added }); before await setupPromise at index $setupAwaitIdx"
}

# Find the await turnPromise line
$turnAwaitIdx = $content.IndexOf("await turnPromise;")
if ($turnAwaitIdx -gt 0) {
    # Insert }); before await turnPromise
    $content = $content.Insert($turnAwaitIdx, "  });`n")
    Write-Host "Added }); before await turnPromise at index $turnAwaitIdx"
}

# Fix the end of file - ensure handleGeminiLiveTurn function is closed
# The function should end with } after the return statement
# Check if the file ends properly
if (-not $content.EndsWith("}")) {
    $content += "`n}"
    Write-Host "Added final }"
}

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"