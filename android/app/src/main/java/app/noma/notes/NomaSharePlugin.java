package app.noma.notes;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android share-target bridge: receives whatever other apps share into
 * Noma (ACTION_SEND / ACTION_SEND_MULTIPLE with text/plain or image/*)
 * and hands it to the web layer's capture queue.
 *
 * MainActivity forwards its launch intent and every onNewIntent here.
 * The payload is held statically (the activity may be recreated before
 * the WebView asks for it) and is consumed on read: getSharedContent
 * returns it exactly once, so a share can never create two notes.
 * Image streams are read on a background executor — never the bridge
 * thread — and size-capped before and during the read.
 */
@CapacitorPlugin(name = "NomaShare")
public class NomaSharePlugin extends Plugin {

    private static final int MAX_IMAGES = 10;
    private static final long MAX_IMAGE_BYTES = 10L * 1024L * 1024L;

    private static final ExecutorService SHARE_EXECUTOR = Executors.newSingleThreadExecutor();

    private static volatile Intent pendingShareIntent;
    private static volatile NomaSharePlugin instance;

    /** Called by MainActivity for the launch intent and every new intent. */
    public static void onShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return;
        }
        pendingShareIntent = intent;
        NomaSharePlugin current = instance;
        if (current != null) {
            current.notifyListeners("shareReceived", new JSObject());
        }
    }

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /**
     * Resolves the pending shared content exactly once; a second call (or a
     * call with nothing shared) resolves null. Extraction runs on the
     * background executor because reading image streams can block.
     */
    @PluginMethod
    public void getSharedContent(PluginCall call) {
        Intent intent = pendingShareIntent;
        pendingShareIntent = null;
        if (intent == null) {
            call.resolve();
            return;
        }
        SHARE_EXECUTOR.execute(() -> {
            try {
                call.resolve(extractPayload(intent));
            } catch (Exception e) {
                // A malformed share drops quietly rather than failing the app.
                call.resolve();
            }
        });
    }

    private JSObject extractPayload(Intent intent) {
        JSObject result = new JSObject();

        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (subject != null && !subject.trim().isEmpty()) {
            result.put("title", subject);
        }

        CharSequence textExtra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = textExtra == null ? null : textExtra.toString();
        String url = null;
        if (text != null) {
            String trimmed = text.trim();
            // A share whose whole text is one bare link is a link share.
            if (trimmed.matches("^https?://\\S+$")) {
                url = trimmed;
                text = null;
            }
        }
        if (text != null && !text.trim().isEmpty()) {
            result.put("text", text);
        }
        if (url != null) {
            result.put("url", url);
        }

        List<Uri> uris = collectStreamUris(intent);
        if (!uris.isEmpty()) {
            JSArray images = new JSArray();
            String intentType = intent.getType();
            for (Uri uri : uris) {
                if (images.length() >= MAX_IMAGES) break;
                JSObject image = readImage(uri, intentType);
                if (image != null) images.put(image);
            }
            if (images.length() > 0) {
                result.put("images", images);
            }
        }
        return result;
    }

    private List<Uri> collectStreamUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> streams;
            if (Build.VERSION.SDK_INT >= 33) {
                streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            }
            if (streams != null) {
                for (Uri uri : streams) {
                    if (uri != null) uris.add(uri);
                }
            }
        } else {
            Uri stream;
            if (Build.VERSION.SDK_INT >= 33) {
                stream = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            }
            if (stream != null) uris.add(stream);
        }
        return uris;
    }

    /** Reads one shared image into a Base64 payload, or null when unusable. */
    private JSObject readImage(Uri uri, String intentType) {
        ContentResolver resolver = getContext().getContentResolver();
        String mimeType = resolver.getType(uri);
        if (mimeType == null && intentType != null && intentType.startsWith("image/")
                && !"image/*".equals(intentType)) {
            mimeType = intentType;
        }
        if (mimeType == null || !mimeType.startsWith("image/")) return null;

        long declaredSize = queryLongColumn(resolver, uri, OpenableColumns.SIZE);
        if (declaredSize > MAX_IMAGE_BYTES) return null;

        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) return null;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            long total = 0;
            int read;
            while ((read = input.read(chunk)) != -1) {
                total += read;
                if (total > MAX_IMAGE_BYTES) return null;
                buffer.write(chunk, 0, read);
            }
            JSObject image = new JSObject();
            image.put("name", queryDisplayName(resolver, uri, mimeType));
            image.put("mimeType", mimeType);
            image.put("dataBase64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
            return image;
        } catch (IOException | SecurityException e) {
            return null;
        }
    }

    private long queryLongColumn(ContentResolver resolver, Uri uri, String column) {
        try (Cursor cursor = resolver.query(uri, new String[]{column}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(column);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (Exception ignored) {
            // Size is a pre-check only; the streaming read enforces the cap too.
        }
        return -1;
    }

    private String queryDisplayName(ContentResolver resolver, Uri uri, String mimeType) {
        try (Cursor cursor = resolver.query(
                uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.trim().isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // Fall through to a generated name.
        }
        String extension = mimeType.equals("image/png") ? ".png"
                : mimeType.equals("image/webp") ? ".webp"
                : mimeType.equals("image/gif") ? ".gif"
                : ".jpg";
        return "shared-image" + extension;
    }
}
