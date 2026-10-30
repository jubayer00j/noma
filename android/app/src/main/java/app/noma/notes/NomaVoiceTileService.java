package app.noma.notes;

import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Quick Settings tile for voice capture (voice capture PR-C): fires
 * the same app.noma.notes://voice-note deep link as the launcher
 * shortcut. The web layer holds the action behind its DB-ready +
 * unlocked gate and opens the listening sheet there — so from the
 * lock screen the user meets the lock first, exactly like the
 * new-note tile; the tile itself records nothing.
 */
public class NomaVoiceTileService extends TileService {

    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setLabel(getString(R.string.tile_voice_label));
            tile.setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher));
            // It's an action, not a toggle: always shown as available.
            tile.setState(Tile.STATE_ACTIVE);
            tile.updateTile();
        }
    }

    @Override
    public void onClick() {
        super.onClick();
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("app.noma.notes://voice-note"));
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
