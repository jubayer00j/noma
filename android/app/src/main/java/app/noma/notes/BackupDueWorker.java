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

import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * Periodic WorkManager job that performs Noma's scheduled backups silently,
 * WhatsApp-style, while the app is closed.
 *
 * It can do this because the web layer STAGES each backup ahead of time
 * (see NomaBackgroundBackupPlugin): a ready-made ZIP in private storage,
 * plus the Drive folder/file IDs. The worker only needs a Drive token —
 * obtained silently through Google Identity, no UI — and plain HTTPS.
 *
 * Fallbacks, by design:
 * - Nothing staged / nothing new / not due yet -> succeed silently.
 * - Upload impossible (Google wants a fresh consent tap, token rejected)
 *   while a backup is due with changes pending -> one gentle reminder
 *   notification that opens Noma, whose scheduler finishes the job.
 * - Transient network / server errors -> Result.retry().
 */
public class BackupDueWorker extends Worker {

    private static final String CHANNEL_ID = "noma_backup_reminders";
    private static final int NOTIFICATION_ID = 4711;
    private static final String DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    private static final String FOLDER_NAME = "Noma Backups";
    private static final String CANONICAL_NAME = "Noma Backup.zip";
    private static final String API = "https://www.googleapis.com/drive/v3";
    private static final String UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

    public BackupDueWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences(
                NomaBackgroundBackupPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        long intervalMinutes = prefs.getLong(NomaBackgroundBackupPlugin.KEY_INTERVAL_MINUTES, 0);
        if (intervalMinutes <= 0) return Result.success();

        // Hard gate: no live Drive connection, no uploads — ever. The web
        // layer clears this flag (and the staged archive) the moment the
        // user disconnects Drive or the account changes.
        if (!prefs.getBoolean(NomaBackgroundBackupPlugin.KEY_CONNECTION_ACTIVE, false)) {
            return Result.success();
        }

        long nextDueAt = prefs.getLong(NomaBackgroundBackupPlugin.KEY_NEXT_DUE_AT, 0);
        long now = System.currentTimeMillis();
        if (nextDueAt > 0 && now < nextDueAt) return Result.success();

        boolean pending = prefs.getBoolean(NomaBackgroundBackupPlugin.KEY_PENDING_CHANGES, false);
        String stagedSignature = prefs.getString(NomaBackgroundBackupPlugin.KEY_STAGED_SIGNATURE, "");
        String uploadedSignature =
                prefs.getString(NomaBackgroundBackupPlugin.KEY_LAST_UPLOADED_SIGNATURE, "");
        File staged = NomaBackgroundBackupPlugin.stagedFile(context);

        if (!staged.exists() || stagedSignature == null || stagedSignature.isEmpty()) {
            if (pending) notifyBackupDue();
            return Result.success();
        }
        if (stagedSignature.equals(uploadedSignature) && !pending) {
            return Result.success();
        }

        // ---- silent token -------------------------------------------------
        String token;
        try {
            token = acquireToken(context);
        } catch (NeedsUserAction e) {
            if (pending) notifyBackupDue();
            return Result.success();
        } catch (TransientFailure e) {
            return Result.retry();
        }
        if (token == null) {
            if (pending) notifyBackupDue();
            return Result.success();
        }

        // ---- upload -------------------------------------------------------
        try {
            String fileId = uploadBackup(context, prefs, token, staged);
            long doneAt = System.currentTimeMillis();
            prefs.edit()
                    .putLong(NomaBackgroundBackupPlugin.KEY_LAST_BACKUP_AT, doneAt)
                    .putString(NomaBackgroundBackupPlugin.KEY_LAST_UPLOADED_SIGNATURE, stagedSignature)
                    .putLong(NomaBackgroundBackupPlugin.KEY_NEXT_DUE_AT,
                            doneAt + intervalMinutes * 60_000L)
                    .putBoolean(NomaBackgroundBackupPlugin.KEY_PENDING_CHANGES, false)
                    .putString(NomaBackgroundBackupPlugin.KEY_BACKUP_FILE_ID, fileId)
                    .apply();
            return Result.success();
        } catch (Unauthorized e) {
            if (pending) notifyBackupDue();
            return Result.success();
        } catch (TransientFailure e) {
            return Result.retry();
        } catch (Exception e) {
            if (pending) notifyBackupDue();
            return Result.success();
        }
    }

    // ------------------------------------------------------------ token

    private static class NeedsUserAction extends Exception {}
    private static class TransientFailure extends Exception {}
    private static class Unauthorized extends Exception {}

    private String acquireToken(Context context) throws NeedsUserAction, TransientFailure {
        AuthorizationClient client = Identity.getAuthorizationClient(context);
        AuthorizationRequest request = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_FILE_SCOPE)))
                .build();
        try {
            AuthorizationResult result = Tasks.await(client.authorize(request), 45, TimeUnit.SECONDS);
            if (result.hasResolution()) throw new NeedsUserAction();
            String token = result.getAccessToken();
            if (token == null || token.isEmpty()) throw new NeedsUserAction();
            return token;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof ApiException
                    && ((ApiException) cause).getStatusCode() == CommonStatusCodes.NETWORK_ERROR) {
                throw new TransientFailure();
            }
            throw new NeedsUserAction();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new TransientFailure();
        } catch (NeedsUserAction | TransientFailure e) {
            throw e;
        } catch (Exception e) {
            throw new NeedsUserAction();
        }
    }

    // ------------------------------------------------------------ Drive

    private String uploadBackup(Context context, SharedPreferences prefs, String token, File staged)
            throws Unauthorized, TransientFailure, Exception {
        String folderId = prefs.getString(NomaBackgroundBackupPlugin.KEY_FOLDER_ID, null);
        if (folderId == null || folderId.isEmpty() || !exists(token, folderId)) {
            folderId = findOrCreateFolder(token);
            prefs.edit().putString(NomaBackgroundBackupPlugin.KEY_FOLDER_ID, folderId).apply();
        }

        String fileId = prefs.getString(NomaBackgroundBackupPlugin.KEY_BACKUP_FILE_ID, null);
        if (fileId != null && !fileId.isEmpty() && exists(token, fileId)) {
            patchFile(token, fileId, staged);
            return fileId;
        }
        String discovered = findCanonicalFile(token, folderId);
        if (discovered != null) {
            patchFile(token, discovered, staged);
            return discovered;
        }
        return createFile(token, folderId, staged);
    }

    private boolean exists(String token, String fileId) throws Unauthorized, TransientFailure, Exception {
        HttpURLConnection conn = open(new URL(API + "/files/" + fileId + "?fields=id,trashed"), token, "GET");
        try {
            int code = conn.getResponseCode();
            if (code == 404) return false;
            if (code == 401) throw new Unauthorized();
            if (code >= 500) throw new TransientFailure();
            if (code != 200) return false;
            JSONObject body = new JSONObject(readBody(conn));
            return !body.optBoolean("trashed", false);
        } finally {
            conn.disconnect();
        }
    }

    private String findOrCreateFolder(String token) throws Unauthorized, TransientFailure, Exception {
        String query = "name='" + FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
        JSONObject found = listFiles(token, query);
        JSONArray files = found.optJSONArray("files");
        if (files != null && files.length() > 0) {
            return files.getJSONObject(0).getString("id");
        }
        JSONObject metadata = new JSONObject();
        metadata.put("name", FOLDER_NAME);
        metadata.put("mimeType", "application/vnd.google-apps.folder");
        HttpURLConnection conn = open(new URL(API + "/files?fields=id"), token, "POST");
        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        byte[] body = metadata.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body);
        }
        int code = conn.getResponseCode();
        if (code == 401) throw new Unauthorized();
        if (code >= 500) throw new TransientFailure();
        if (code != 200) throw new Exception("Folder create failed: " + code);
        String id = new JSONObject(readBody(conn)).getString("id");
        conn.disconnect();
        return id;
    }

    private String findCanonicalFile(String token, String folderId) throws Unauthorized, TransientFailure, Exception {
        String query = "name='" + CANONICAL_NAME + "' and '" + folderId + "' in parents and trashed=false";
        JSONObject found = listFiles(token, query);
        JSONArray files = found.optJSONArray("files");
        if (files != null && files.length() > 0) {
            return files.getJSONObject(0).getString("id");
        }
        return null;
    }

    private JSONObject listFiles(String token, String query) throws Unauthorized, TransientFailure, Exception {
        String url = API + "/files?q=" + URLEncoder.encode(query, "UTF-8") + "&fields=files(id,createdTime)";
        HttpURLConnection conn = open(new URL(url), token, "GET");
        try {
            int code = conn.getResponseCode();
            if (code == 401) throw new Unauthorized();
            if (code >= 500) throw new TransientFailure();
            if (code != 200) throw new Exception("List failed: " + code);
            return new JSONObject(readBody(conn));
        } finally {
            conn.disconnect();
        }
    }

    private void patchFile(String token, String fileId, File staged) throws Unauthorized, TransientFailure, Exception {
        HttpURLConnection conn = open(
                new URL(UPLOAD_API + "/files/" + fileId + "?uploadType=media&fields=id"), token, "PATCH");
        conn.setRequestProperty("Content-Type", "application/zip");
        conn.setFixedLengthStreamingMode(staged.length());
        try (OutputStream out = conn.getOutputStream(); InputStream in = new FileInputStream(staged)) {
            copy(in, out);
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        if (code == 401) throw new Unauthorized();
        if (code >= 500) throw new TransientFailure();
        if (code != 200) throw new Exception("Upload failed: " + code);
    }

    private String createFile(String token, String folderId, File staged) throws Unauthorized, TransientFailure, Exception {
        String boundary = "noma" + System.currentTimeMillis();
        JSONObject metadata = new JSONObject();
        metadata.put("name", CANONICAL_NAME);
        metadata.put("mimeType", "application/zip");
        metadata.put("parents", new JSONArray().put(folderId));
        byte[] head = ("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                + metadata + "\r\n--" + boundary + "\r\nContent-Type: application/zip\r\n\r\n")
                .getBytes(StandardCharsets.UTF_8);
        byte[] tail = ("\r\n--" + boundary + "--").getBytes(StandardCharsets.UTF_8);

        HttpURLConnection conn = open(
                new URL(UPLOAD_API + "/files?uploadType=multipart&fields=id"), token, "POST");
        conn.setRequestProperty("Content-Type", "multipart/related; boundary=" + boundary);
        conn.setFixedLengthStreamingMode(head.length + staged.length() + tail.length);
        try (OutputStream out = conn.getOutputStream(); InputStream in = new FileInputStream(staged)) {
            out.write(head);
            copy(in, out);
            out.write(tail);
        }
        int code = conn.getResponseCode();
        if (code == 401) throw new Unauthorized();
        if (code >= 500) throw new TransientFailure();
        if (code != 200) throw new Exception("Create failed: " + code);
        String id = new JSONObject(readBody(conn)).getString("id");
        conn.disconnect();
        return id;
    }

    private HttpURLConnection open(URL url, String token, String method) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(120_000);
        if (!method.equals("GET")) conn.setDoOutput(true);
        return conn;
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        out.flush();
    }

    private static String readBody(HttpURLConnection conn) throws Exception {
        InputStream in = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (in == null) return "";
        try (InputStream body = in) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = body.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toString("UTF-8");
        }
    }

    // ------------------------------------------------------------ reminder fallback

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
            // Permission raced away — the in-app scheduler still covers it.
        }
    }
}
