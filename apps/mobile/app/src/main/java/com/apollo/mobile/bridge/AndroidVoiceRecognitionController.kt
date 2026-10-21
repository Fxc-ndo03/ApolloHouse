package com.apollo.mobile.bridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.Locale

/** One-shot, user-initiated speech capture. No wake word or continuous listener. */
class AndroidVoiceRecognitionController(
    private val activity: Activity,
    private val submitText: (String) -> Boolean,
    private val emit: (String, String) -> Unit,
) {
    private var recognizer: SpeechRecognizer? = null
    private var waitingForPermission = false

    fun start() {
        activity.runOnUiThread {
            if (waitingForPermission) return@runOnUiThread
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                waitingForPermission = true
                activity.requestPermissions(
                    arrayOf(Manifest.permission.RECORD_AUDIO),
                    REQUEST_RECORD_AUDIO,
                )
                return@runOnUiThread
            }
            startRecognizer()
        }
    }

    fun stop() {
        activity.runOnUiThread {
            waitingForPermission = false
            recognizer?.stopListening()
        }
    }

    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQUEST_RECORD_AUDIO || !waitingForPermission) return
        waitingForPermission = false
        activity.runOnUiThread {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                startRecognizer()
            } else {
                emitError("permission_denied", "Apollo necesita permiso de micrófono para escuchar.")
            }
        }
    }

    fun destroy() {
        activity.runOnUiThread {
            waitingForPermission = false
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null
        }
    }

    private fun startRecognizer() {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            emitError("unavailable", "El reconocimiento de voz no está disponible en este dispositivo.")
            return
        }
        runCatching {
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(activity).also { speech ->
            speech.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = emit("orb-state-change", JSONObject.quote("listening"))
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = emit("orb-state-change", JSONObject.quote("thinking"))
                override fun onError(error: Int) {
                    if (error != SpeechRecognizer.ERROR_CLIENT) {
                        emitError("speech_recognition_failed", "No se pudo reconocer el audio. Inténtalo de nuevo.")
                    }
                    emit("orb-state-change", JSONObject.quote("idle"))
                }
                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.trim().orEmpty()
                    if (text.isEmpty()) {
                        emitError("empty_speech", "No se detectó voz.")
                        emit("orb-state-change", JSONObject.quote("idle"))
                    } else if (!submitText(text)) {
                        emitError("unavailable", "No hay conexión con Apollo. El texto no se envió.")
                        emit("orb-state-change", JSONObject.quote("error"))
                    }
                }
                override fun onPartialResults(partialResults: Bundle?) = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
                speech.startListening(
                    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    },
                )
            }
        }.onFailure {
            recognizer?.destroy()
            recognizer = null
            emitError("speech_recognition_failed", "No se pudo iniciar el reconocimiento de voz.")
            emit("orb-state-change", JSONObject.quote("error"))
        }
    }

    private fun emitError(code: String, message: String) {
        emit("error", JSONObject().put("code", code).put("message", message).toString())
    }

    companion object {
        const val REQUEST_RECORD_AUDIO = 0xA331
    }
}
