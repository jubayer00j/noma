package app.noma.notes;

import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Quick Settings tile: the lock-screen-accessible capture door. Android
 * doesn't let apps place their own lock-screen shortcuts, but the QS
 * panel is reachable from the lock screen on most devices — one tap
 * here fires the same app.noma.notes://new-note deep link as the
 * launcher shortcut and widget. If Noma's App Lock is on, the user
 * simply meets the lock screen and the capture completes after unlock;
 * the tile never bypasses it.
 */
public class NomaCaptureTileService extends TileService {

    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setLabel(getString(R.string.tile_label));
            tile.setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher));
            // It's an action, not a toggle: always shown as available.
            tile.setState(Tile.STATE_ACTIVE);
            tile.updateTile();
        }
    }

    @Override
    public void onClick() {
        super.onClick();
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("app.noma.notes://new-note"));
        intent.setClass(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (Build.VERSION.SDK_INT >= 34) {
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this, 0, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            startActivityAndCollapse(pendingIntent);
        } else {
            startActivityAndCollapse(intent);
        }
    }
}
