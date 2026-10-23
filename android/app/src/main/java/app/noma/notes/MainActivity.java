package app.noma.notes;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Splash handoff (native-feel #5): the custom overlay dismisses when
    // the web layer signals its first painted frame (window.NomaSplash
    // .ready(), see splash-handoff.ts) — never before the minimum
    // display (a shorter artwork flash reads as a glitch, not a splash)
    // and never after the fallback, which replaces the old fixed 1s
    // timer: if no signal ever comes (bundle failure, JS never runs),
    // the user must still never be trapped behind the splash.
    private static final long SPLASH_MIN_DISPLAY_MS = 500;
    private static final long SPLASH_FALLBACK_MS = 3000;
    private static final long SPLASH_ARTWORK_FADE_IN_MS = 200;
    private static final long SPLASH_FADE_OUT_MS = 300;

    private View splashOverlay;
    private WindowInsetsControllerCompat splashInsetsController;
    private Handler splashHandler;
    private long splashShownAtMs;
    private boolean splashDismissed;

    /**
     * The web layer's "first frame painted" signal. @JavascriptInterface
     * methods run on a WebView background thread — marshal to the UI
     * thread before the dismiss policy touches any view.
     */
    public class NomaSplashBridge {
        @JavascriptInterface
        public void ready() {
            runOnUiThread(MainActivity.this::onSplashReadySignal);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleDriveAuthPlugin.class);
        registerPlugin(NomaBackupPlugin.class);
        registerPlugin(NomaBiometricPlugin.class);
        registerPlugin(NomaAlarmPlugin.class);
        registerPlugin(NomaBackgroundBackupPlugin.class);
        registerPlugin(NomaSharePlugin.class);

        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        splashScreen.setOnExitAnimationListener(provider -> {
            provider.remove();
        });

        super.onCreate(savedInstanceState);

        // Edge-to-edge is the permanent state (native-feel #2): the window
        // never returns to decor-fitted after the splash — the web layer
        // handles system-bar/cutout insets via CSS safe-area padding, and
        // the app surfaces paint behind the transparent bars.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // No system scrim over the app's bottom surface in gesture nav.
            getWindow().setNavigationBarContrastEnforced(false);
        }

        splashShownAtMs = SystemClock.uptimeMillis();
        splashHandler = new Handler(Looper.getMainLooper());

        splashOverlay = getLayoutInflater().inflate(R.layout.noma_splash_screen, null);
        addContentView(splashOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // Soften the system-splash → overlay pop (native-feel #5, F3):
        // the overlay's background is the same splash_background colour
        // as the system splash, so the overlay itself stays opaque and
        // only the artwork fades in — fading the whole overlay would
        // briefly reveal the still-unpainted WebView behind it.
        ImageView artwork = splashOverlay.findViewById(R.id.noma_splash_image);
        if (artwork != null) {
            artwork.setAlpha(0f);
            artwork.animate().alpha(1f).setDuration(SPLASH_ARTWORK_FADE_IN_MS).start();
        }

        splashInsetsController = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (splashInsetsController != null) {
            splashInsetsController.hide(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
            splashInsetsController.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }

        // Register the ready signal on the Capacitor WebView. Verified
        // against the installed @capacitor/android 7 sources:
        // BridgeActivity owns the bridge, Bridge.getWebView() returns
        // its WebView, the Bridge installs its BridgeWebViewClient once
        // in init(), and Capacitor's own MessageHandler registers the
        // same way under "androidBridge" — addJavascriptInterface is
        // independent of the WebViewClient and does not disturb it.
        // This runs synchronously in onCreate, before the locally
        // served page can execute any script; and if an interface ever
        // did miss a page load, the fallback below still dismisses.
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new NomaSplashBridge(), "NomaSplash");
        }

        // Fallback: dismiss even if no ready signal ever arrives.
        splashHandler.postDelayed(this::dismissSplash, SPLASH_FALLBACK_MS);

        // Hand the launch intent to the share target (a no-op for ordinary
        // launches — the plugin only keeps ACTION_SEND / SEND_MULTIPLE).
        NomaSharePlugin.onShareIntent(getIntent());
    }

    /** Ready signal arrived (UI thread): dismiss now, or at the minimum display. */
    private void onSplashReadySignal() {
        long remainingMs = SPLASH_MIN_DISPLAY_MS - (SystemClock.uptimeMillis() - splashShownAtMs);
        if (remainingMs <= 0) {
            dismissSplash();
        } else {
            splashHandler.postDelayed(this::dismissSplash, remainingMs);
        }
    }

    /**
     * The dismiss sequence (the original timer version's, unchanged):
     * show the bars — staying edge-to-edge, no decorFits(true) restore —
     * fade the overlay out and remove it. Idempotent: the ready signal,
     * the minimum-display timer and the fallback can race; only the
     * first call acts.
     */
    private void dismissSplash() {
        if (splashDismissed) {
            return;
        }
        splashDismissed = true;
        splashHandler.removeCallbacksAndMessages(null);
        if (splashOverlay == null || splashOverlay.getParent() == null) {
            return;
        }
        // Show the bars, but stay edge-to-edge: no decorFits(true)
        // restore — the running app keeps drawing behind the bars.
        if (splashInsetsController != null) {
            splashInsetsController.show(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
        }
        splashOverlay.animate()
                .alpha(0f)
                .setDuration(SPLASH_FADE_OUT_MS)
                .withEndAction(() -> {
                    if (splashOverlay != null && splashOverlay.getParent() != null) {
                        ((ViewGroup) splashOverlay.getParent()).removeView(splashOverlay);
                        splashOverlay = null;
                    }
                })
                .start();
    }

    @Override
    public void onDestroy() {
        // A pending fallback / minimum-display callback must not
        // outlive the activity.
        if (splashHandler != null) {
            splashHandler.removeCallbacksAndMessages(null);
        }
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // super first: Capacitor's bridge needs it for appUrlOpen and the
        // other plugins' intent handling.
        super.onNewIntent(intent);
        // singleTask: shares into a running Noma arrive here.
        NomaSharePlugin.onShareIntent(intent);
    }
}
