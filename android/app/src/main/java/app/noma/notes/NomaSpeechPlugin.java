package app.noma.notes;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
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
        // Honesty pass: isRecognitionAvailable only proves a service is
        // REGISTERED. If the app providing the default service has been
        // disabled (a common debloat move — e.g. disabling the Google
        // app), createSpeechRecognizer still binds to it and every
        // session dies instantly with a generic error. Detect that
        // here so the web layer can stop offering a dead mic and say
        // why. Skipped when an on-device recogniser exists: start
        // prefers it, so the session may still be viable.
        if (available && !onDevice) {
            String disabledApp = disabledDefaultServiceApp();
            if (disabledApp != null) {
                res.put("available", false);
                res.put("reason", "service-disabled");
                res.put("serviceApp", disabledApp);
            }
        }
        call.resolve(res);
    }

    /**
     * The label of the app providing the system's default recognition
     * service when that app (or the service component itself) is
     * disabled; null when the default service looks runnable or can't
     * be determined — any failure stays silent and the base probe
     * stands.
     */
    private String disabledDefaultServiceApp() {
        try {
            Context ctx = getContext();
            // Settings.Secure.VOICE_RECOGNITION_SERVICE's value; the
            // constant is not public API, the key string is stable.
            String flat = Settings.Secure.getString(
                ctx.getContentResolver(), "voice_recognition_service");
            if (flat == null || flat.isEmpty()) return null;
            ComponentName service = ComponentName.unflattenFromString(flat);
            if (service == null) return null;
            PackageManager pm = ctx.getPackageManager();
            int appState = pm.getApplicationEnabledSetting(service.getPackageName());
            int serviceState = pm.getComponentEnabledSetting(service);
            boolean disabled = appState == PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                || appState == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER
                || serviceState == PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            if (!disabled) return null;
            try {
                ApplicationInfo info = pm.getApplicationInfo(service.getPackageName(), 0);
                CharSequence label = pm.getApplicationLabel(info);
                return label != null ? label.toString() : service.getPackageName();
            } catch (Exception e) {
                return service.getPackageName();
            }
        } catch (Exception e) {
            return null;
        }
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
        // The call settles immediately: recognition itself is
        // event-driven, and speech.ts awaits this promise — leaving it
        // pending would hang that await and leak a call per restart.
        call.resolve();
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
        call.resolve();
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        mainHandler.post(this::destroyRecognizer);
        call.resolve();
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
            SpeechRecognizer created = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                try {
                    created = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
                } catch (Exception e) {
                    // The probe said on-device exists but creation
                    // failed (quirky OEM build) — fall through to the
                    // platform recogniser rather than failing the
                    // session. The Settings disclosure keys off the
                    // same probe, so the two stay aligned.
                    Log.w(TAG, "on-device recogniser creation failed; using platform recogniser", e);
                }
            }
            recognizer = created != null
                ? created
                : SpeechRecognizer.createSpeechRecognizer(getContext());
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
            // Deliberately NOT forwarded: Android calls this BEFORE
            // onResults, and the web layer restarts the engine the
            // moment it hears "end" — forwarding it here would have
            // the restart destroy this recogniser and discard the
            // utterance's final text. speechEnd is emitted at the end
            // of onResults instead; errors terminate via speechError.
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
            // The utterance is fully delivered — now the end is safe
            // to signal (see onEndOfSpeech).
            notifyListeners("speechEnd", new JSObject());
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
