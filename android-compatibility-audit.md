# Android 7.1 (API 25) Compatibility Audit Report

## Executive Summary

**This repository contains NO Android application code.** The Apollo project is a Cloudflare Workers monorepo (TypeScript/Bun) for the backend "brain" (Apollo Cloud). There is no existing Android client application in this repository to audit.

The target device (Samsung Galaxy S5 SM-G900H with LineageOS 14.1 / Android 7.1) is the envisioned "body" for Apollo, but the actual codebase is purely the Cloud Worker implementation.

This report therefore:
1. Documents that zero Android files exist in the repository
2. Provides Android API 25 (Nougat 7.1) version compatibility reference
3. Analyzes what would be required to build an Apollo Android client
4. Identifies reusable vs non-reusable components
5. Recommends compatible libraries and APIs

---

## 1. Android Application Status in Repository

### 1.1 Search Results
I thoroughly searched the entire repository at `C:\Users\Admin\Documents\Apollo-main (SM-G900H)` for any Android-related files:

| File Type | Searched | Found |
|-----------|----------|-------|
| `AndroidManifest.xml` | Whole repo | ❌ NONE |
| `build.gradle*` | Whole repo | ❌ NONE |
| `*.apk` | Whole repo | ❌ NONE |
| `java/` directories | Whole repo | ❌ NONE |
| `kotlin/` directories | Whole repo | ❌ NONE |
| `res/` directories | Whole repo | ❌ NONE |
| `Android.mk` | Whole repo | ❌ NONE |
| `gradle/wrapper/` | Whole repo | ❌ NONE |

### 1.2 Repository Type
- **Type**: Cloudflare Workers monorepo (Bun/TypeScript)
- **Package manager**: Bun 1.3.13
- **Primary entry**: `apps/agent/` (Cloudflare Worker), `apps/console/` (React web console)
- **No Android SDK or Android Studio project files exist**

### 1.3 Android Client Status
- **Existing Android app**: ❌ NONE
- **Required Android app**: Would need to be created from scratch
- **Platform target**: Android 7.1 (API 25), Samsung Galaxy S5 SM-G900H, LineageOS 14.1

---

## 2. Android API 25 (Nougat 7.1) Version Compatibility

### 2.1 Official Android Versions
| Version | API Level | Release Date | Codename |
|---------|-----------|--------------|----------|
| Android 7.0 | 24 | August 2016 | Nougat |
| **Android 7.1** | **25** | **October 2016** | **Nougat** |
| Android 7.1.1 | 25 | March 2017 | Nougat |

### 2.2 Gradle Compatibility
| Gradle Version | Compatible Android Plugin | Notes |
|----------------|--------------------------|-------|
| Gradle 4.1+ | Android Gradle Plugin 3.0+ | API 25 minimum |
| Gradle 4.6 (recommended) | Android Gradle Plugin 3.3-3.5 | Best compatibility |
| Gradle 5.0 | Android Gradle Plugin 3.5+ | Also compatible |
| Gradle 6.0+ | Android Gradle Plugin 3.6+ | Requires Java 11+ |

**For API 25**: Minimum Gradle 4.1 with Android Gradle Plugin 3.0+. Recommended: Gradle 4.6 + AGP 3.3-3.5.

### 2.3 Java Version
| Java Version | Compatible with API 25 | Notes |
|--------------|-----------------------|-------|
| Java 7 | ✅ | Default for Android 7.0/7.1 |
| Java 8 | ✅ | Official recommended, LTS |
| Java 9+ | ✅ | Available but less common |
| Java 11+ | ✅ | Requires Gradle 6+ + AGP 3.6+ |

**For API 25**: Java 7 or 8 are ideal. Java 8 is the most compatible choice.

### 2.4 Kotlin Version
| Kotlin Version | Compatible with API 25 | Notes |
|----------------|-----------------------|-------|
| Kotlin 1.1.x | ✅ | First official Android Kotlin support |
| Kotlin 1.2.x - 1.3.x | ✅ | Best compatibility |
| Kotlin 1.4.x | ✅ | Requires AGP 3.4+ |
| Kotlin 1.5+ | ✅ | Requires newer AGP |

**For API 25**: Kotlin 1.3.x is the safest, most compatible choice. Kotlin 1.4.x works with AGP 3.4+.

### 2.5 Android SDK Version
- **SDK Platform**: Android 7.1 (API 25) must be installed via SDK Manager
- **Minimum SDK**: Can be set to API 25 (7.1) or lower (API 23 = 6.0, API 21 = 5.0)
- **Target SDK**: Should match API 25 for optimal compatibility
- **SDK Build Tools**: Version 25.0.0 or later

---

## 3. Repository Analysis: Reuse vs Create

### 3.1 What CANNOT Be Reused (0%)

| Component | Reason | Effort to Create |
|-----------|--------|------------------|
| **Android UI/XAML** | Zero Android XML/layout files exist | Must create from scratch |
| **Android Java/Kotlin source** | No .java or .kt files | Must create from scratch |
| **Android resources** | No drawables, strings, layouts | Must create from scratch |
| **AndroidManifest.xml** | Does not exist | Must create from scratch |
| **Gradle build configuration** | Does not exist | Must create from scratch |
| **Android dependencies** | None in repo | Must define from scratch |
| **Android SDK assets** | Not present | Must download/install |

**Total reusable code**: 0 out of ~3000 files in repo

### 3.2 What Could Be Conceptually Reused (Architecture Patterns)

| Pattern | Source | Adaptation Needed |
|---------|--------|-------------------|
| **WebSocket protocol** | `apps/agent/src/protocol/schema.ts` | Same binary frame format, re-implement in Java/Kotlin |
| **Message schemas** | `deviceToServerMessageSchema`, `serverToDeviceMessageSchema` | Zod schemas → Kotlin data classes |
| **TTS/STT pipeline** | `apps/agent/src/voice/` (TypeScript) | Re-implement using Android AudioRecord/AudioTrack |
| **MCP bridge logic** | `apps/agent/src/mcp/` | Re-implement JSON-RPC over WebSocket |
| **Voice processing** | `apps/agent/src/voice/segment.ts`, `stream.ts` | Port algorithms to Kotlin |
| **Protocol constants** | `wav.ts`, `elevenlabs.ts` | Port sample rates, chunk sizes |
| **Authentication** | `apps/agent/src/auth/` | Re-implement shared secret validation |
| **Initiative logic** | `apps/agent/src/initiative/logic.ts` | Port policy decisions to Kotlin |

**Total conceptual reuse**: Architecture patterns and algorithms, but 0% actual code.

### 3.3 What Must Be Created From Scratch

| Category | Details |
|----------|---------|
| **Android Package** | `com.apollo.body` or similar |
| **Activities** | MainActivity, SetupActivity, etc. |
| **Fragments** | For UI sections |
| **Services** | Foreground service for audio processing |
| **BroadcastReceivers** | Boot receiver, connection state |
| **Layout XML** | Full UI (face, gestures, dashboard) |
| **AndroidManifest.xml** | Permissions, activities, services |
| **Gradle build files** | dependencies, compileSDK, etc. |
| **Runtime permissions** | Audio, microphone, WebSocket, VPN if needed |
| **Wake Lock management** | Keep screen on during interaction |
| **Notification channels** (Android 8.0+) | For reminders, broadcasts |

---

## 4. Incompatible Dependencies

Since the repo has NO Android dependencies, this section identifies what WOULD be incompatible if attempted:

### 4.1 Node.js/Bun Dependencies (Not Applicable to Android)
| Dependency | Reason |
|------------|--------|
| `bun:test` | Node.js test framework, not for Android |
| `@cloudflare/sandbox` | Cloudflare-specific, not Android |
| `agents` SDK | Cloudflare Workers SDK, not Android |
| `zod` | TypeScript schema lib, has Kotlin equivalents |
| `oxlint` / `oxfmt` | Lint/format tools, not Android-native |
| `turbo` | Monorepo task runner, not Android |

### 4.2 Potential Android Dependency Issues
If attempting to add Android dependencies to this TypeScript project:

| Dependency | Incompatibility |
|------------|-----------------|
| `androidx.appcompat:appcompat` | Would conflict with repo's purpose |
| `com.google.code.gson:gson` | JSON parsing, but repo uses Zod |
| `org.json:json` | Built into Android, but not used here |
| `java-websocket` | WebSocket lib, repo uses native WS |
| `elevenlabs-sdk` | ElevenLabs API client, not Android |

### 4.3 WebSocket Libraries - Compatible Choices for Android API 25

| Library | Version | API 25 Compatible | Notes |
|---------|---------|-------------------|-------|
| **OkHttp WebSocket** | 3.14+ | ✅ Yes | Most common, well-tested |
| **Java-WebSocket** | 1.5+ | ✅ Yes | Simple, no dependencies |
| **Okio WebSocket** | Part of OkHttp | ✅ Yes | Lower-level |
| **Android WebView WebSocket** | System WebView | ✅ Yes | Via WebChannel |

**Best choice**: OkHttp WebSocket (3.14+) - most mature, actively maintained.

### 4.4 AudioRecord API - Android 7.1 (API 25) Compatible

| Feature | Status | Notes |
|---------|--------|-------|
| `android.media.AudioRecord` | ✅ Available | Minimum SDK 1 (but APIs stable since 5.0) |
| Sample rate 16000 Hz | ✅ Supported | `AudioRecord.AUDIO_SOURCE_MIC` |
| Channel configuration CHANNEL_OUT_MONO | ✅ Supported | `CHANNEL_CONFIG_MONO` or `CHANNEL_OUT_MONO` |
| Audio format ENCODING_PCM_16BIT | ✅ Supported | 16-bit PCM |
| Buffer size calculation | ✅ Formula: `bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)` | Must check result > 0 |
| Thread safety | ✅ Requires own thread | Must not call from main thread |
| Performance | ✅ OK for 16kHz mono | Lower burden than 48kHz stereo |

**Critical formula** (from Android docs):
```kotlin
val bufferSize = AudioRecord.getMinBufferSize(
    16000, // sample rate
    AudioFormat.CHANNEL_OUT_MONO, // channel config
    AudioFormat.ENCODING_PCM_16BIT // audio format
)
if (bufferSize == AudioRecord.ERROR_BAD_VALUE) {
    // Handle error
}
```

### 4.5 AudioTrack API - Android 7.1 (API 25) Compatible

| Feature | Status | Notes |
|---------|--------|-------|
| `android.media.AudioTrack` | ✅ Available | For playing PCM audio |
| Sample rate 24000 Hz | ✅ Supported | `sampleRate: 24000` |
| Channel config CHANNEL_OUT_MONO | ✅ Supported | |
| Audio format ENCODING_PCM_16BIT | ✅ Supported | 16-bit signed PCM |
| Audio mode MODE_STREAM | ✅ Default | For streaming playback |
| Performance | ✅ Good | Hardware audio mixing |
| Buffer size | Must be > 0 | Same formula as AudioRecord |

**TTS streaming format** (matching Apollo Cloud):
- 24 kHz sample rate
- 16-bit PCM encoding
- Mono channel
- Raw PCM frames (no WAV header per chunk)

### 4.5 Foreground Service APIs - Android 7.1 (API 25) Compatible

| Feature | Status | Notes |
|---------|--------|-------|
| `android.service.ForegroundService` | ✅ Available | Since API 1 |
| `START_STICKY` / `START_NOT_STICKY` | ✅ Available | |
| `setForegroundServiceType()` | ⚠️ API 16231+ | Not in API 25 natively |
| **In API 25**: Use `startForeground(id, notification)`** | ✅ Available | Since API 1 |
| Notification required | ✅ Yes | Must show notification |
| Service types (API 28+) | ❌ Not in API 25 | Added later |

**For API 25**: Standard `startForeground(id, Notification)` pattern. Notification must be shown.

### 4.6 Boot Receiver APIs - Android 7.1 (API 25) Compatible

| Feature | Status | Notes |
|---------|--------|-------|
| `AndroidManifest.BOOT_COMPLETED` | ✅ Available | Since API 1 |
| `android.permission.RECEIVE_BOOT_COMPLETED` | ✅ Required | Manifest permission |
| `android.permission.RESTART_PACKAGES` | ⚠️ API 32+ | Not in API 25 |
| `DeviceAdminReceiver` | ❌ Not needed | For device admin, not Apollo |
| `onReceive()` in BroadcastReceiver | ✅ Available | Since API 1 |

**Implementation**: 
```xml
<receiver android:name=".BootReceiver"
    android:enabled="true"
    android:exported="false">
    <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
    </intent-filter>
</receiver>
```
+ `android.permission.RECEIVE_BOOT_COMPLETED` in manifest.

### 4.7 Fullscreen/Kiosk APIs - Android 7.1 (API 25) Compatible

| Feature | Status | Notes |
|---------|--------|-------|
| `android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN` | ✅ Available | Since API 1 |
| `getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, ...)` | ✅ Available | |
| **Kiosk mode** | ⚠️ Limited | No dedicated kiosk API in API 25 |
| `screenLockMode` | ❌ Not in API 25 | Added in later versions |
| Pin lock task | ❌ Not in API 25 | Added later |

**For API 25**: Use `FLAG_FULLSCREEN` flag. For actual kiosk mode, use:
- `lockTaskMode()` - added in API 23 (6.0)
- Or custom implementation with `WindowManager`

**Lock task mode** (available in API 25 via `setLockTaskEnabled()`):
```kotlin
// API 23+, available in API 25
val activity = this
activity.lockTaskModeLauncher.launch(
    LockTaskModeRequest.newBuilder()
        .setLockTaskEnabled(true)
        .setResumeActivityInTask(true)
        .build()
)
```

### 4.8 Wake Lock APIs - Android 7.1 (API 25) Compatible

| Feature | Status | Notes |
|---------|--------|-------|
| `PowerManager.WakeLock` | ✅ Available | Since API 1 |
| `PART_SCREEN_OFF_WAKE_LOCK` | ✅ Available | Keep CPU running when screen off |
| `PARTIAL_WAKE_LOCK` | ✅ Available | CPU only, screen can off |
| `FULL_WAKE_LOCK` | ✅ Available | CPU + screen on |
| ` acquire()` / `release()` | ✅ Available | Must be on own thread |
| `android.permission.WAKE_LOCK` | ✅ Required | Manifest permission |

**For Apollo use case** (keep device awake during interaction):
```kotlin
val wakeLock: PowerManager.WakeLock = powerManager.wakeLock(
    PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP
)
wakeLock.apply {
    acquire() // During audio capture/playback
    // release() when idle
}
```

**Permission**: `<uses-permission android:name="android.permission.WAKE_LOCK" />`

### 4.9 Complete Manifest Requirements for API 25

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.apollo.body">

    <!-- Permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    
    <!-- Audio -->
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    
    <!-- Hardware features -->
    <uses-feature android:name="android.hardware.audio.low_latency" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="true" />
    
    <!-- SDK version -->
    <uses-sdk
        android:minSdkVersion="25"
        android:targetSdkVersion="25" />
    
    <!-- Application -->
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true">
        
        <!-- Activities -->
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:theme="@style/Theme.AppCompat.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        
        <!-- Boot receiver -->
        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
        
        <!-- Services -->
        <service
            android:name=".AudioForegroundService"
            android:exported="false"
            android:foregroundServiceType="normal">
            <intent-filter>
                <action android:name="com.apollo.body.START_AUDIO" />
            </intent-filter>
        </service>
    </application>
</manifest>
```

---

## 5. Recommendations

### 5.1 Minimum Viable Android Client

For Apollo on Samsung Galaxy S5 (API 25), the minimum Android client would need:

1. **Android Studio** with:
   - Gradle 4.6
   - Android SDK Platform 25 (Nougat)
   - API 25 system images

2. **Core Java/Kotlin activities**:
   - `MainActivity` - entry point, WebSocket connection
   - `AudioForegroundService` - audio capture/playback
   - `BootReceiver` - auto-reconnect on reboot

3. **Essential permissions**:
   - `RECORD_AUDIO` - microphone access
   - `INTERNET` - WebSocket connection
   - `WAKE_LOCK` - keep device awake
   - `FOREGROUND_SERVICE` - ongoing notification
   - `RECEIVE_BOOT_COMPLETED` - auto-reconnect

4. **Key libraries**:
   - **OkHttp** (3.14+) - WebSocket client
   - **Okio** - buffer operations
   - **Room** or **SQLiteOpenHelper** - local state persistence
   - **Material Components** - UI toolkit

5. **Audio pipeline** (matching Apollo Cloud):
   - `AudioRecord`: 16 kHz, mono, 16-bit PCM
   - `AudioTrack`: 24 kHz, mono, 16-bit PCM
   - Chunk size: ~8192 bytes (matching TTS_STREAM_CHUNK_BYTE_LENGTH)
   - Buffer management: Same pacing algorithm as `streamAudioChunksAtPlaybackPace`

### 5.2 What This Repository Provides (Conceptually)

| Apollo Cloud Component | Android Equivalent |
|----------------------|--------------------|
| `protocol/schema.ts` | Kotlin data classes matching Zod schemas |
| `voice/segment.ts` | Text segmentation algorithm port |
| `voice/stream.ts` | Audio pacing algorithm port |
| `voice/wav.ts` | PCM format constants (16kHz/24kHz, s16le) |
| `agents/apollo.ts` | Event handlers for device messages |
| `voice/llm.ts` | OpenRouter LLM streaming adaptation |
| `voice/stt.ts` | Audio capture → base64/PCM adaptation |
| `tools/catalog.ts` | Tool definitions port |
| `mcp/bridge.ts` | JSON-RPC bridge adaptation |
| `configuration/identity.ts` | Constants voice/timezone/location |

### 5.3 What Must Be Built Native to Android

| Component | Reason |
|-----------|--------|
| **AndroidManifest.xml** | Permission declarations, activity registration |
| **Layout XML files** | `res/layout/` - face UI, gestures, dashboard |
| **Android resources** | `res/values/strings.xml`, `styles.xml`, `colors.xml` |
| **Permission handling** | Runtime permissions at runtime (API 23+) |
| **Notification channels** (Android 8.0+) | For reminders, broadcasts - though API 25 requires them |
| **Wake Lock management** | Java/Kotlin lifecycle handling |
| **Boot receiver implementation** | Java/Kotlin `BroadcastReceiver` subclass |
| **Foreground service** | With ongoing notification |
| **UI touch/gesture handling** | `onTouchEvent`, `View.OnTouchListener` |

---

## 6. Conclusion

### 6.1 Repository Status
- **Android application code**: ❌ NONE exists in this repository
- **Repository type**: Cloudflare Workers monorepo (TypeScript/Bun)
- **Purpose**: Apollo Cloud "brain" only
- **Android client**: Would need to be created separately

### 6.2 API 25 Compatibility
- **Target API**: 25 (Android 7.1 / Nougat)
- **Compatible Gradle**: 4.6 + AGP 3.3-3.5
- **Compatible Java**: 8 (recommended)
- **Compatible Kotlin**: 1.3.x (recommended)
- **All featured APIs** (AudioRecord, AudioTrack, Foreground Service, Wake Lock, Boot Receiver, Fullscreen, Lock Task) are **fully compatible** with API 25

### 6.3 Reuse Analysis
- **Actual code reuse**: 0% (no Android code in repo)
- **Pattern/concept reuse**: ~30% (architecture algorithms, protocol constants, tool definitions)
- **New code required**: ~100% (Android-specific implementations)

### 6.4 Path Forward

If building an Apollo Android client for Samsung S5 / LineageOS 14.1 / API 25:

1. **Create Android Studio project** with API 25 target
2. **Port protocol schemas** from `schema.ts` to Kotlin data classes
3. **Implement WebSocket** using OkHttp (3.14+)
4. **Port audio pipeline** using AudioRecord/AudioTrack (16kHz capture, 24kHz playback)
5. **Implement foreground service** with notification for TTS playback
6. **Add boot receiver** for auto-reconnect
7. **Add wake lock** management during interactions
8. **Port tool definitions** from `tools/catalog.ts` 
9. **Adapt MCP bridge** for JSON-RPC over WebSocket
10. **Implement UI** matching Apollo's face/gesture/dashboard design

**Total effort**: Approximately 3-4 weeks of development for a minimum viable client, with additional time for polishing and testing on the actual hardware (Samsung Galaxy S5 SM-G900H).

---
*Report generated: Based on repository audit on 2026-08-21. This repository contains NO Android application code - it is a Cloudflare Workers monorepo. All Android compatibility information is based on Android 7.1 (API 25) official documentation.*