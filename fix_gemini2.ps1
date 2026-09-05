$content = Get-Content "apps/agent/src/voice/geminiLive.ts" -Raw
$first = $content.IndexOf("  });")
$second = $content.IndexOf("  });", $first + 1)
Write-Host "First at: $first"
Write-Host "Second at: $second"
$between = $content.Substring($first, $second - $first)
Write-Host "Between: [$between]"
# Remove the second });
$newContent = $content.Remove($second, 4)
Set-Content "apps/agent/src/voice/geminiLive.ts" -Value $newContent -Encoding UTF8
Write-Host "Done"