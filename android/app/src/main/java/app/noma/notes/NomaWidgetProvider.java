package app.noma.notes;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * Home-screen capture widget: a single branded tap target that opens a
 * fresh note through the existing app.noma.notes://new-note deep link —
 * the same strictly validated path the launcher shortcut uses. It shows
 * no note content (widgets can't read the WebView's IndexedDB) and never
 * updates on a timer, so it costs no battery.
 */
public class NomaWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("app.noma.notes://new-note"));
            intent.setClass(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    context, 0, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.noma_widget);
            views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);
            appWidgetManager.updateAppWidget(appWidgetId, views);
        }
    }
}
