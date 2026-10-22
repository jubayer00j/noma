package app.noma.notes;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Periodic WorkManager job behind Noma's scheduled backups. The backup
 * itself is produced by the web layer (it owns the database and the Drive
 * upload), so this worker's one job is the closed-app case: when the web
 * layer last reported unsynced changes AND the scheduled time has passed,
 * post one gentle reminder that opens Noma, whose scheduler then runs the
 * backup immediately. It never fires when nothing is pending or the
 * schedule isn't due, and it stays silent without notification permission.
 */
public class BackupDueWorker extends Worker {

    private static final String CHANNEL_ID = "noma_backup_reminders";
    private static final int NOTIFICATION_ID = 4711;

    public BackupDueWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences(NomaBackgroundBackupPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        boolean pending = prefs.getBoolean(NomaBackgroundBackupPlugin.KEY_PENDING_CHANGES, false);
        long nextDueAt = prefs.getLong(NomaBackgroundBackupPlugin.KEY_NEXT_DUE_AT, 0);
        if (!pending || nextDueAt <= 0 || System.currentTimeMillis() < nextDueAt) {
            return Result.success();
        }
        notifyBackupDue();
        return Result.success();
    }

    private void notifyBackupDue() {
        Context context = getApplicationContext();
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Backup reminders", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Lets you know when a scheduled Noma backup is due.");
            manager.createNotificationChannel(channel);
        }

        Intent openApp = new Intent(context, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context, 0, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(context.getApplicationInfo().icon)
                .setContentTitle("Noma backup is due")
                .setContentText("You have changes that aren't backed up yet. Tap to open Noma and finish your scheduled backup.")
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException ignored) {
            // Permission raced away between the check and the post — the
            // in-app scheduler covers the backup at the next open anyway.
        }
    }
}
