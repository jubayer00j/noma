package app.noma.notes;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Voice capture engine (voice capture PR-A): a thin, honest wrapper
 * over Android's SpeechRecognizer. The web layer (speech.ts) owns the
 * session state machine, transcript assembly and every product
 * decision; this class only:
 *
 *  - probes availability (and whether an on-device recogniser exists),
 *  - runs the RECORD_AUDIO runtime permission through Capacitor's
 *    alias flow, exactly like NomaBackup's storage permission,
 *  - runs ONE single-utterance recognition at a time and forwards its
 *    callbacks as plugin events: speechReady, speechPartial,
 *    speechFinal, speechEnd, speechError.
 *
 * Continuous dictation is the web layer restarting a finished
 * utterance while its session is still live — the recogniser itself
 * stays single-shot, which keeps its lifecycle (and its failure
 * modes) small and predictable.
 *
 * SpeechRecognizer must live on the main thread, so every recogniser
 * touch is posted to the main looper; plugin methods arrive on
 * Capacitor's background thread. A generation counter guards the
 * listener: callbacks from a cancelled or replaced recogniser are
 * dropped instead of leaking stale text into a new session.
 *
 * No audio is ever written anywhere by this class — the recogniser's
 * stream passes through the platform service and only text comes
 * back. On devices without an on-device recogniser that service is
 * the device's own speech service (usually Google's); the Settings
 * copy in PR-B discloses that, and this class adds nothing to it.
 */
@CapacitorPlugin(
    name = "NomaSpeech",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class NomaSpeechPlugin extends Plugin {

    private static final String TAG = "NomaSpeech";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private int generation = 0;

    // ------------------------------------------------------------------
    // Availability + permission
    // ------------------------------------------------------------------

    @PluginMethod
    public void isAvailable(PluginCall call) {
        boolean available = SpeechRecognizer.isRecognitionAvailable(getContext());
        boolean onDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
        JSObject res = new JSObject();
        res.put("available", available);
        res.put("onDevice", onDevice);
        call.resolve(res);
    }

    @PluginMethod
    public void checkMicrophoneAccess(PluginCall call) {
        PermissionState state = getPermissionState("microphone");
        JSObject res = new JSObject();
        res.put("state", state == null ? "prompt" : state.toString());
        call.resolve(res);
    }

    @PluginMethod
    public void ensureMicrophoneAccess(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
        } else {
            requestPermissionForAlias("microphone", call, "microphoneCallback");
        }
    }

    @PermissionCallback
    private void microphoneCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
        } else {
            call.reject("Microphone permission was denied.", "USER_CANCELLED");
        }
    }

    // ------------------------------------------------------------------
    // Recognition
    // ------------------------------------------------------------------

    @PluginMethod
    public void startListening(PluginCall call) {
        String language = call.getString("language");
        mainHandler.post(() -> startOnMain(language));
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        mainHandler.post(() -> {
            if (recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (Exception e) {
                    Log.w(TAG, "stopListening failed", e);
                }
            }
        });
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        mainHandler.post(this::destroyRecognizer);
    }

    @Override
    protected void handleOnDestroy() {
        mainHandler.post(this::destroyRecognizer);
        super.handleOnDestroy();
    }

    /** Main thread only. Starts a fresh single-utterance recognition. */
    private void startOnMain(String language) {
        destroyRecognizer();
        final int gen = ++generation;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
            } else {
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            }
        } catch (Exception e) {
            Log.w(TAG, "createSpeechRecognizer failed", e);
            emitError(gen, SpeechRecognizer.ERROR_CLIENT);
            return;
        }
        recognizer.setRecognitionListener(new SessionListener(gen));

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        if (language != null && !language.isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        }
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        try {
            recognizer.startListening(intent);
        } catch (Exception e) {
            Log.w(TAG, "startListening failed", e);
            emitError(gen, SpeechRecognizer.ERROR_CLIENT);
        }
    }

    /** Main thread only. Cancels and releases the current recogniser. */
    private void destroyRecognizer() {
        generation++;
        if (recognizer != null) {
            try {
                recognizer.cancel();
            } catch (Exception ignored) {
                // Already dead — nothing to release beyond the reference.
            }
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
                // Same: destruction is best-effort.
            }
            recognizer = null;
        }
    }

    private void emitError(int gen, int code) {
        if (gen != generation) return;
        JSObject data = new JSObject();
        data.put("code", code);
        data.put("kind", errorKind(code));
        notifyListeners("speechError", data);
    }

    /** Stable error kinds — the web layer maps these to calm UI states. */
    static String errorKind(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no-match";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "speech-timeout";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "permission";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            case SpeechRecognizer.ERROR_CLIENT:
            default:
                return "client";
        }
    }

    private class SessionListener implements RecognitionListener {
        private final int gen;

        SessionListener(int gen) {
            this.gen = gen;
        }

        private boolean live() {
            return gen == generation;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (live()) notifyListeners("speechReady", new JSObject());
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
            if (live()) notifyListeners("speechEnd", new JSObject());
        }

        @Override
        public void onError(int error) {
            if (!live()) return;
            JSObject data = new JSObject();
            data.put("code", error);
            data.put("kind", errorKind(error));
            notifyListeners("speechError", data);
        }

        @Override
        public void onResults(Bundle results) {
            if (!live()) return;
            String text = firstResult(results);
            if (text != null) {
                JSObject data = new JSObject();
                data.put("text", text);
                notifyListeners("speechFinal", data);
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (!live()) return;
            String text = firstResult(partialResults);
            if (text != null) {
                JSObject data = new JSObject();
                data.put("text", text);
                notifyListeners("speechPartial", data);
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }

        private String firstResult(Bundle bundle) {
            ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches == null || matches.isEmpty()) return null;
            String text = matches.get(0);
            return text == null || text.trim().isEmpty() ? null : text;
        }
    }
}
