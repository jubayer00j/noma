package app.noma.notes;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Home-screen widget (v2, native-feel #10).
 *
 * Widgets can't read the WebView's IndexedDB, so the web layer stages a
 * small JSON snapshot of what the widget may show (see
 * NomaWidgetPlugin) and this provider renders from that file:
 *
 *   - No snapshot, a corrupt one, or a "generic" one (the web layer
 *     stages generic whenever App Lock is on) — and every compact
 *     placement regardless — renders the v1 widget exactly as it has
 *     always been: one branded tap target into a fresh note. The widget
 *     never renders an error or a blank.
 *   - A content snapshot at a large size renders the full layout: a
 *     header (tap → new note), a Today row (the daily note's title, or
 *     an invitation when the day has none; tap → the today door), and
 *     one row per snapshot note (tap → that note's deep link).
 *
 * It never updates on a timer (updatePeriodMillis stays 0): freshness
 * comes from the staging pushes, so it costs no battery.
 */
public class NomaWidgetProvider extends AppWidgetProvider {

    /**
     * Size class thresholds, in dp, read from the widget options
     * bundle: a placement at least this wide AND this tall gets the full
     * layout. Roughly a 4×3 placement on a typical launcher (a 2×1 or
     * 4×2 stays compact); the full layout needs the height for its
     * header + Today row + up to three note rows.
     */
    private static final int FULL_MIN_WIDTH_DP = 200;
    private static final int FULL_MIN_HEIGHT_DP = 170;

    private static final int MAX_NOTE_ROWS = 3;

    /** Snapshots are a few hundred bytes; anything bigger is not ours. */
    private static final long MAX_SNAPSHOT_BYTES = 64L * 1024L;

    // PendingIntent request codes. The compact widget's root keeps v1's
    // code 0; every full-layout row gets its own code so the rows'
    // intents can never overwrite one another.
    private static final int REQUEST_HEADER = 10;
    private static final int REQUEST_TODAY = 11;
    private static final int REQUEST_NOTE_BASE = 12;

    private static final int[] NOTE_ROW_IDS = {
            R.id.widget_note_row_1, R.id.widget_note_row_2, R.id.widget_note_row_3
    };
    private static final int[] NOTE_TITLE_IDS = {
            R.id.widget_note_title_1, R.id.widget_note_title_2, R.id.widget_note_title_3
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            renderWidget(context, appWidgetManager, appWidgetId);
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager appWidgetManager,
                                           int appWidgetId, Bundle newOptions) {
        renderWidget(context, appWidgetManager, appWidgetId);
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions);
    }

    private void renderWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        Snapshot snapshot = readSnapshot(context);
        Bundle options = appWidgetManager.getAppWidgetOptions(appWidgetId);
        RemoteViews views = snapshot != null && isFullSize(options)
                ? buildFullViews(context, snapshot)
                : buildCompactViews(context);
        appWidgetManager.updateAppWidget(appWidgetId, views);
    }

    /** The v1 widget, unchanged: one branded tap target into a new note. */
    private RemoteViews buildCompactViews(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.noma_widget);
        views.setOnClickPendingIntent(R.id.widget_root,
                activityIntent(context, "app.noma.notes://new-note", 0));
        return views;
    }

    private RemoteViews buildFullViews(Context context, Snapshot snapshot) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.noma_widget_full);
        views.setOnClickPendingIntent(R.id.widget_header,
                activityIntent(context, "app.noma.notes://new-note", REQUEST_HEADER));

        views.setTextViewText(R.id.widget_today_title, snapshot.todayTitle != null
                ? snapshot.todayTitle
                : context.getString(R.string.widget_today_invite));
        views.setOnClickPendingIntent(R.id.widget_today_row,
                activityIntent(context, "app.noma.notes://today", REQUEST_TODAY));

        for (int i = 0; i < NOTE_ROW_IDS.length; i++) {
            if (i < snapshot.notes.size()) {
                SnapshotNote note = snapshot.notes.get(i);
                views.setViewVisibility(NOTE_ROW_IDS[i], View.VISIBLE);
                views.setTextViewText(NOTE_TITLE_IDS[i], note.title);
                views.setOnClickPendingIntent(NOTE_ROW_IDS[i],
                        activityIntent(context, "app.noma.notes://note/" + note.id,
                                REQUEST_NOTE_BASE + i));
            } else {
                views.setViewVisibility(NOTE_ROW_IDS[i], View.GONE);
            }
        }
        return views;
    }

    private PendingIntent activityIntent(Context context, String url, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setClass(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                context, requestCode, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private boolean isFullSize(Bundle options) {
        if (options == null) return false;
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
        if (width == 0) width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        if (height == 0) height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        return width >= FULL_MIN_WIDTH_DP && height >= FULL_MIN_HEIGHT_DP;
    }

    /* ---------------- Snapshot reading ---------------- */

    private static final class SnapshotNote {
        final String id;
        final String title;

        SnapshotNote(String id, String title) {
            this.id = id;
            this.title = title;
        }
    }

    private static final class Snapshot {
        /** Null when the day has no (readable) daily note → invitation. */
        final String todayTitle;
        final List<SnapshotNote> notes;

        Snapshot(String todayTitle, List<SnapshotNote> notes) {
            this.todayTitle = todayTitle;
            this.notes = notes;
        }
    }

    /**
     * Reads and validates the staged snapshot. Returns null for anything
     * that isn't a well-formed content snapshot — missing file, oversize,
     * unparseable, wrong version, or generic mode — and the caller falls
     * back to the compact v1 rendering. Entry-level damage is contained:
     * a note row with a missing id or title is skipped, never fatal.
     */
    private Snapshot readSnapshot(Context context) {
        try {
            File file = NomaWidgetPlugin.snapshotFile(context);
            if (!file.isFile() || file.length() == 0 || file.length() > MAX_SNAPSHOT_BYTES) {
                return null;
            }
            String json;
            try (InputStream in = new FileInputStream(file)) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int read;
                while ((read = in.read(chunk)) != -1) {
                    buffer.write(chunk, 0, read);
                }
                json = buffer.toString(StandardCharsets.UTF_8.name());
            }
            JSONObject root = new JSONObject(json);
            if (root.optInt("v", 0) != 1) return null;
            if (!"content".equals(root.optString("mode", ""))) return null;

            String todayTitle = null;
            JSONObject today = root.optJSONObject("today");
            if (today != null) {
                String title = today.optString("title", "").trim();
                if (!title.isEmpty()) todayTitle = title;
            }

            List<SnapshotNote> notes = new ArrayList<>();
            JSONArray array = root.optJSONArray("notes");
            if (array != null) {
                for (int i = 0; i < array.length() && notes.size() < MAX_NOTE_ROWS; i++) {
                    JSONObject entry = array.optJSONObject(i);
                    if (entry == null) continue;
                    String id = entry.optString("id", "").trim();
                    String title = entry.optString("title", "").trim();
                    if (!id.isEmpty() && !title.isEmpty()) {
                        notes.add(new SnapshotNote(id, title));
                    }
                }
            }
            return new Snapshot(todayTitle, notes);
        } catch (Exception e) {
            return null;
        }
    }
}
