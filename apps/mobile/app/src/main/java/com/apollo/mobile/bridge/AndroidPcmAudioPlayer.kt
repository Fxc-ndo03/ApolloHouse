package com.apollo.mobile.bridge

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import android.util.Log
import com.apollo.mobile.conversation.ConversationOwner
import com.apollo.mobile.conversation.ConversationState

/** Plays the raw PCM frames that the Apollo Worker streams after `tts_start`. */
internal class AndroidPcmAudioPlayer(context: Context) : ConversationOwner.Observer {

    private val preferences = context.applicationContext.getSharedPreferences(
        com.apollo.mobile.settings.AppSettingsStore.PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val lock = Any()
    private var audioTrack: AudioTrack? = null
    private var streamMuted = false
    private var streamFailed = false
    private var sampleRateHz = 0
    private var channelCount = 0
    private var bytesWritten = 0L

    override fun onAudioStarted(format: String?, sampleRate: Int?, channels: Int?) {
        finishStream(aborted = true)
        synchronized(lock) {
            streamMuted = preferences.getBoolean("tts_muted", false)
            streamFailed = false
            sampleRateHz = sampleRate ?: 0
            channelCount = channels ?: 0
            bytesWritten = 0L
            if (streamMuted || format != PCM_FORMAT || sampleRateHz <= 0) return

            val outputChannelMask = when (channelCount) {
                1 -> AudioFormat.CHANNEL_OUT_MONO
                2 -> AudioFormat.CHANNEL_OUT_STEREO
                else -> return
            }
            val minimumBufferBytes = AudioTrack.getMinBufferSize(
                sampleRateHz,
                outputChannelMask,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            if (minimumBufferBytes <= 0) {
                streamFailed = true
                return
            }

            val createdTrack = runCatching {
                AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(sampleRateHz)
                            .setChannelMask(outputChannelMask)
                            .build(),
                    )
                    .setBufferSizeInBytes(maxOf(minimumBufferBytes * 2, sampleRateHz * channelCount / 5))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
            }.getOrElse { error ->
                streamFailed = true
                Log.w(TAG, "PCM playback initialization failed (${error.javaClass.simpleName})")
                return
            }
            if (createdTrack.state != AudioTrack.STATE_INITIALIZED) {
                createdTrack.release()
                streamFailed = true
                return
            }
            runCatching { createdTrack.play() }
                .onSuccess { audioTrack = createdTrack }
                .onFailure { error ->
                    createdTrack.release()
                    streamFailed = true
                    Log.w(TAG, "PCM playback start failed (${error.javaClass.simpleName})")
            }
        }
    }

    override fun onAudioChunk(payload: ByteArray) {
        synchronized(lock) {
            val track = audioTrack ?: return
            if (streamMuted || streamFailed || channelCount <= 0) return
            val frameBytes = channelCount * BYTES_PER_SAMPLE
            val alignedSize = payload.size - (payload.size % frameBytes)
            if (alignedSize <= 0) return

            var offset = 0
            while (offset < alignedSize) {
                val written = runCatching {
                    track.write(payload, offset, alignedSize - offset, AudioTrack.WRITE_BLOCKING)
                }.getOrElse { error ->
                    streamFailed = true
                    Log.w(TAG, "PCM playback write failed (${error.javaClass.simpleName})")
                    return
                }
                if (written <= 0) {
                    streamFailed = true
                    return
                }
                offset += written
                bytesWritten += written
            }
        }
    }

    override fun onAudioEnded(aborted: Boolean) = finishStream(aborted)

    override fun onStateChanged(state: ConversationState) {
        if (state == ConversationState.DISCONNECTED || state == ConversationState.DENIED) {
            finishStream(aborted = true)
        }
    }

    fun release() = finishStream(aborted = true)

    private fun finishStream(aborted: Boolean) {
        synchronized(lock) {
            val track = audioTrack
            audioTrack = null
            if (track != null) {
                if (!aborted && !streamMuted && !streamFailed && sampleRateHz > 0 && channelCount > 0) {
                    val frameBytes = channelCount * BYTES_PER_SAMPLE
                    val targetFrames = bytesWritten / frameBytes
                    val deadline = SystemClock.uptimeMillis() + DRAIN_TIMEOUT_MS
                    while (unsignedPlaybackHead(track) < targetFrames &&
                        SystemClock.uptimeMillis() < deadline
                    ) {
                        SystemClock.sleep(DRAIN_POLL_MS)
                    }
                }
                runCatching { track.stop() }
                track.release()
            }
            streamMuted = false
            streamFailed = false
            sampleRateHz = 0
            channelCount = 0
            bytesWritten = 0L
        }
    }

    private fun unsignedPlaybackHead(track: AudioTrack): Long =
        track.playbackHeadPosition.toLong() and 0xffff_ffffL

    private companion object {
        const val TAG = "ApolloAudio"
        const val PCM_FORMAT = "pcm"
        const val BYTES_PER_SAMPLE = 2
        const val DRAIN_TIMEOUT_MS = 6_000L
        const val DRAIN_POLL_MS = 20L
    }
}
