package app.noma.notes;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Staging bridge for the home-screen widget v2 (native-feel #10).
 *
 * Widgets can't read the WebView's IndexedDB, so the web layer — which
 * owns the data — builds a small JSON snapshot of what the widget may
 * show (Today's title plus up to three note titles, already filtered by
 * the web layer's privacy rules) and stages it here, into the app's
 * private files directory. NomaWidgetProvider renders from that file
 * with no WebView alive. Same staged discipline as the background
 * backup (NomaBackgroundBackupPlugin): write a temp file, then rename
 * over the target, so a reader never sees a half-written snapshot.
 *
 * Both methods are failure-proof by contract: a staging problem must
 * never break, delay, or throw into whatever the user was doing, so
 * every failure is logged and the call resolves anyway — the widget
 * simply keeps showing its previous (or branded fallback) state.
 */
@CapacitorPlugin(name = "NomaWidget")
public class NomaWidgetPlugin extends Plugin {

    private static final String TAG = "NomaWidget";
    public static final String SNAPSHOT_DIR_NAME = "noma-widget";
    public static final String SNAPSHOT_FILE_NAME = "snapshot.json";

    /** The staged snapshot file the widget provider reads. */
    public static File snapshotFile(Context context) {
        File dir = new File(context.getFilesDir(), SNAPSHOT_DIR_NAME);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, SNAPSHOT_FILE_NAME);
    }

    /**
     * Writes the web layer's snapshot JSON atomically (temp + rename)
     * and refreshes every placed widget. A null/empty payload is
     * ignored rather than staged — clearing goes through clearSnapshot.
     */
    @PluginMethod
    public void stageSnapshot(PluginCall call) {
        String json = call.getString("json");
        try {
            if (json != null && !json.isEmpty()) {
                File target = snapshotFile(getContext());
                File temp = new File(target.getParentFile(), SNAPSHOT_FILE_NAME + ".tmp");
                try (FileOutputStream out = new FileOutputStream(temp)) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
                if (target.exists() && !target.delete()) {
                    //noinspection ResultOfMethodCallIgnored
                    temp.delete();
                    throw new IllegalStateException("Couldn't replace the previous snapshot");
                }
                if (!temp.renameTo(target)) {
                    //noinspection ResultOfMethodCallIgnored
                    temp.delete();
                    throw new IllegalStateException("Couldn't finalize the snapshot");
                }
                refreshWidgets();
            }
        } catch (Exception e) {
            Log.w(TAG, "stageSnapshot failed; widget keeps its previous state", e);
        }
        call.resolve();
    }

    /**
     * Deletes the staged snapshot (sign-out, account switch) and
     * refreshes: with no snapshot on disk the provider falls back to the
     * branded v1 look, so one account's titles never outlive it.
     */
    @PluginMethod
    public void clearSnapshot(PluginCall call) {
        try {
            File target = snapshotFile(getContext());
            if (target.exists()) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
            refreshWidgets();
        } catch (Exception e) {
            Log.w(TAG, "clearSnapshot failed", e);
        }
        call.resolve();
    }

    /**
     * Asks the system to re-render every placed Noma widget. Going
     * through the ACTION_APPWIDGET_UPDATE broadcast keeps the provider's
     * own lifecycle in charge of the render, exactly as if the launcher
     * had requested it.
     */
    private void refreshWidgets() {
        try {
            Context context = getContext();
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            ComponentName provider = new ComponentName(context, NomaWidgetProvider.class);
            int[] ids = manager.getAppWidgetIds(provider);
            if (ids.length == 0) return;
            Intent intent = new Intent(context, NomaWidgetProvider.class);
            intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
            context.sendBroadcast(intent);
        } catch (Exception e) {
            Log.w(TAG, "refreshWidgets failed", e);
        }
    }
}
