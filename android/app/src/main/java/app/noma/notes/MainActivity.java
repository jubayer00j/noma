package app.noma.notes;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private View splashOverlay;

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

        splashOverlay = getLayoutInflater().inflate(R.layout.noma_splash_screen, null);
        addContentView(splashOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        WindowInsetsControllerCompat insetsController = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (insetsController != null) {
            insetsController.hide(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
            insetsController.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }

        splashOverlay.postDelayed(() -> {
            if (splashOverlay != null && splashOverlay.getParent() != null) {
                // Show the bars, but stay edge-to-edge: no decorFits(true)
                // restore — the running app keeps drawing behind the bars.
                if (insetsController != null) {
                    insetsController.show(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
                }
                splashOverlay.animate()
                        .alpha(0f)
                        .setDuration(300)
                        .withEndAction(() -> {
                            if (splashOverlay != null && splashOverlay.getParent() != null) {
                                ((ViewGroup) splashOverlay.getParent()).removeView(splashOverlay);
                                splashOverlay = null;
                            }
                        })
                        .start();
            }
        }, 1000);

        // Hand the launch intent to the share target (a no-op for ordinary
        // launches — the plugin only keeps ACTION_SEND / SEND_MULTIPLE).
        NomaSharePlugin.onShareIntent(getIntent());
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
