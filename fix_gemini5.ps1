$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw

# Find the setupPromise Promise constructor closing
# It should be after the close event listener for setup, before the try { await setupPromise }
# Look for the pattern: ws.addEventListener('close', ...) followed by }); then try { await setupPromise
$setupCloseIdx = $content.IndexOf("ws.addEventListener('close',")
if ($setupCloseIdx -gt 0) {
    # Find the closing }); of the close event listener
    $closeListenerEndIdx = $content.IndexOf("    });", $setupCloseIdx)
    if ($closeListenerEndIdx -gt 0) {
        # Insert }); after the close listener
        $insertIdx = $closeListenerEndIdx + 5
        $content = $content.Insert($insertIdx, "`n  });")
        Write-Host "Added }); after setup close listener at $insertIdx"
    }
}

# Find the turnPromise Promise constructor closing
# It should be after the error event listener for turn, before await turnPromise
$turnErrorIdx = $content.IndexOf("ws.addEventListener('error',", $content.IndexOf("turnPromise"))
if ($turnErrorIdx -gt 0) {
    # Find the closing }); of the error event listener
    $errorListenerEndIdx = $content.IndexOf("      });", $turnErrorIdx)
    if ($errorListenerEndIdx -gt 0) {
        # Insert }); after the error listener
        $insertIdx = $errorListenerEndIdx + 7
        $content = $content.Insert($insertIdx, "`n  });")
        Write-Host "Added }); after turn error listener at $insertIdx"
    }
}

# Ensure the file ends with a single }
$content = $content.TrimEnd() + "`n}"

Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $content -Encoding UTF8
Write-Host "Done"