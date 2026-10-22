package app.noma.notes;

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

        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        splashScreen.setOnExitAnimationListener(provider -> {
            provider.remove();
        });

        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

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
                WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
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
    }
}
