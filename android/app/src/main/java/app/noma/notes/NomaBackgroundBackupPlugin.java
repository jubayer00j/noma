package app.noma.notes;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Bridge between the web backup scheduler and the native background backup.
 *
 * The web layer owns the data, so it builds each scheduled backup ZIP and
 * STAGES it here (chunked, into the app's private files directory) along
 * with the library signature it represents and the Drive folder/file IDs
 * it knows. A WorkManager job (BackupDueWorker) can then upload that file
 * silently at the scheduled time — no WebView, no IndexedDB access needed.
 * This class also keeps the shared bookkeeping (schedule, pending state,
 * last successful upload) in SharedPreferences that both sides read.
 */
@CapacitorPlugin(name = "NomaBackgroundBackup")
public class NomaBackgroundBackupPlugin extends Plugin {

    public static final String PREFS_NAME = "noma_backup_schedule";
    public static final String KEY_INTERVAL_MINUTES = "intervalMinutes";
    public static final String KEY_PENDING_CHANGES = "pendingChanges";
    public static final String KEY_LAST_BACKUP_AT = "lastBackupAt";
    public static final String KEY_NEXT_DUE_AT = "nextDueAt";
    public static final String KEY_STAGED_SIGNATURE = "stagedSignature";
    public static final String KEY_STAGED_AT = "stagedAt";
    public static final String KEY_LAST_UPLOADED_SIGNATURE = "lastUploadedSignature";
    public static final String KEY_FOLDER_ID = "folderId";
    public static final String KEY_BACKUP_FILE_ID = "backupFileId";
    public static final String UNIQUE_WORK_NAME = "noma-backup-due";
    public static final String STAGED_FILE_NAME = "staged_backup.zip";

    private final Map<String, FileOutputStream> stageStreams = new ConcurrentHashMap<>();
    private final Map<String, File> stageTempFiles = new ConcurrentHashMap<>();
    private final Map<String, String> stageSignatures = new ConcurrentHashMap<>();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static File stagedFile(Context context) {
        File dir = new File(context.getFilesDir(), "noma-backup");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, STAGED_FILE_NAME);
    }

    // ------------------------------------------------------------ schedule

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
        String folderId = call.getString("folderId");
        String backupFileId = call.getString("backupFileId");
        SharedPreferences.Editor editor = prefs().edit()
                .putBoolean(KEY_PENDING_CHANGES, pending != null && pending)
                .putLong(KEY_LAST_BACKUP_AT, lastBackupAt == null ? 0 : lastBackupAt.longValue())
                .putLong(KEY_NEXT_DUE_AT, nextDueAt == null ? 0 : nextDueAt.longValue());
        if (folderId != null && !folderId.isEmpty()) editor.putString(KEY_FOLDER_ID, folderId);
        if (backupFileId != null && !backupFileId.isEmpty()) {
            editor.putString(KEY_BACKUP_FILE_ID, backupFileId);
        }
        editor.apply();
        call.resolve();
    }

    // ------------------------------------------------------------ staging

    @PluginMethod
    public void beginStage(PluginCall call) {
        String signature = call.getString("signature", "");
        String folderId = call.getString("folderId");
        String backupFileId = call.getString("backupFileId");
        try {
            File dir = new File(getContext().getFilesDir(), "noma-backup");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            String sessionId = UUID.randomUUID().toString();
            File temp = new File(dir, "staged_backup.tmp-" + sessionId);
            stageStreams.put(sessionId, new FileOutputStream(temp));
            stageTempFiles.put(sessionId, temp);
            stageSignatures.put(sessionId, signature == null ? "" : signature);
            SharedPreferences.Editor editor = prefs().edit();
            if (folderId != null && !folderId.isEmpty()) editor.putString(KEY_FOLDER_ID, folderId);
            if (backupFileId != null && !backupFileId.isEmpty()) {
                editor.putString(KEY_BACKUP_FILE_ID, backupFileId);
            }
            editor.apply();
            JSObject res = new JSObject();
            res.put("sessionId", sessionId);
            call.resolve(res);
        } catch (IOException e) {
            call.reject("Couldn't open the staging file: " + e.getMessage(), "STAGE_OPEN");
        }
    }

    @PluginMethod
    public void appendStageChunk(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String chunkBase64 = call.getString("chunkBase64");
        FileOutputStream stream = sessionId == null ? null : stageStreams.get(sessionId);
        if (stream == null || chunkBase64 == null) {
            call.reject("Unknown staging session", "STAGE_SESSION");
            return;
        }
        try {
            stream.write(Base64.decode(chunkBase64, Base64.DEFAULT));
            call.resolve();
        } catch (IOException | IllegalArgumentException e) {
            call.reject("Couldn't write the staging chunk: " + e.getMessage(), "STAGE_WRITE");
        }
    }

    @PluginMethod
    public void finishStage(PluginCall call) {
        String sessionId = call.getString("sessionId");
        FileOutputStream stream = sessionId == null ? null : stageStreams.remove(sessionId);
        File temp = sessionId == null ? null : stageTempFiles.remove(sessionId);
        String signature = sessionId == null ? null : stageSignatures.remove(sessionId);
        if (stream == null || temp == null) {
            call.reject("Unknown staging session", "STAGE_SESSION");
            return;
        }
        try {
            stream.close();
            File target = stagedFile(getContext());
            if (target.exists() && !target.delete()) {
                call.reject("Couldn't replace the previous staged backup", "STAGE_REPLACE");
                return;
            }
            if (!temp.renameTo(target)) {
                call.reject("Couldn't finalize the staged backup", "STAGE_RENAME");
                return;
            }
            prefs().edit()
                    .putString(KEY_STAGED_SIGNATURE, signature == null ? "" : signature)
                    .putLong(KEY_STAGED_AT, System.currentTimeMillis())
                    .apply();
            JSObject res = new JSObject();
            res.put("staged", true);
            res.put("size", target.length());
            call.resolve(res);
        } catch (IOException e) {
            call.reject("Couldn't finalize the staged backup: " + e.getMessage(), "STAGE_CLOSE");
        }
    }

    @PluginMethod
    public void cancelStage(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId != null) {
            FileOutputStream stream = stageStreams.remove(sessionId);
            File temp = stageTempFiles.remove(sessionId);
            stageSignatures.remove(sessionId);
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                }
            }
            if (temp != null) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
        }
        call.resolve();
    }

    // ------------------------------------------------------------ status

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences prefs = prefs();
        JSObject res = new JSObject();
        res.put("lastBackupAt", (double) prefs.getLong(KEY_LAST_BACKUP_AT, 0));
        res.put("lastUploadedSignature", prefs.getString(KEY_LAST_UPLOADED_SIGNATURE, ""));
        res.put("stagedSignature", prefs.getString(KEY_STAGED_SIGNATURE, ""));
        res.put("stagedAt", (double) prefs.getLong(KEY_STAGED_AT, 0));
        call.resolve(res);
    }
}
