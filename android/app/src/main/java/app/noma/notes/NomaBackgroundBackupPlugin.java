package app.noma.notes;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

/**
 * Registers Noma's scheduled-backup cadence with WorkManager and remembers
 * the backup state the web layer reports (pending changes, last backup,
 * next due time). The actual backup is built and uploaded by the web layer
 * whenever Noma runs — this native side is the safety net that notices,
 * while the app is closed, when a scheduled backup has fallen due with
 * changes still pending (see BackupDueWorker).
 */
@CapacitorPlugin(name = "NomaBackgroundBackup")
public class NomaBackgroundBackupPlugin extends Plugin {

    public static final String PREFS_NAME = "noma_backup_schedule";
    public static final String KEY_INTERVAL_MINUTES = "intervalMinutes";
    public static final String KEY_PENDING_CHANGES = "pendingChanges";
    public static final String KEY_LAST_BACKUP_AT = "lastBackupAt";
    public static final String KEY_NEXT_DUE_AT = "nextDueAt";
    public static final String UNIQUE_WORK_NAME = "noma-backup-due";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void setSchedule(PluginCall call) {
        Integer interval = call.getInt("intervalMinutes", 1440);
        long intervalMinutes = interval == null ? 1440 : interval;
        // WorkManager's periodic minimum is 15 minutes; Noma's UI minimum is 60.
        if (intervalMinutes < 15) intervalMinutes = 15;

        prefs().edit().putLong(KEY_INTERVAL_MINUTES, intervalMinutes).apply();

        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                BackupDueWorker.class, intervalMinutes, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(getContext()).enqueueUniquePeriodicWork(
                UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
        call.resolve();
    }

    @PluginMethod
    public void cancelSchedule(PluginCall call) {
        WorkManager.getInstance(getContext()).cancelUniqueWork(UNIQUE_WORK_NAME);
        prefs().edit()
                .putLong(KEY_INTERVAL_MINUTES, 0)
                .putBoolean(KEY_PENDING_CHANGES, false)
                .putLong(KEY_NEXT_DUE_AT, 0)
                .apply();
        call.resolve();
    }

    @PluginMethod
    public void reportState(PluginCall call) {
        Boolean pending = call.getBoolean("pendingChanges", false);
        Double lastBackupAt = call.getDouble("lastBackupAt", 0.0);
        Double nextDueAt = call.getDouble("nextDueAt", 0.0);
        prefs().edit()
                .putBoolean(KEY_PENDING_CHANGES, pending != null && pending)
                .putLong(KEY_LAST_BACKUP_AT, lastBackupAt == null ? 0 : lastBackupAt.longValue())
                .putLong(KEY_NEXT_DUE_AT, nextDueAt == null ? 0 : nextDueAt.longValue())
                .apply();
        call.resolve();
    }
}
