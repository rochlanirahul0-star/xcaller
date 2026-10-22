package com.jarvis.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * Picks the connection back up after a reboot or an app update, so notifications
 * resume without the user having to open XCaller again.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;

        SharedPreferences sp = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        String token = sp.getString("token", null);
        if (token == null || token.isEmpty()) return;

        Intent svc = new Intent(context, NotifyService.class);
        svc.putExtra("token", token);
        // Foreground service from the boot allowlist: the reliable path on Android 8+,
        // where a plain startService from a receiver can be refused outright.
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) context.startForegroundService(svc);
            else context.startService(svc);
        } catch (Exception ignored) {}
    }
}
