package com.jarvis.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Keeps one small connection to the server while the app is in the background and
 * raises the notifications Android gives a real messenger:
 *
 *   • a message  → notification per chat (tap opens that chat)
 *   • an incoming call → full-screen ringing screen with sound + vibration
 *
 * It polls /chat/api/inbox?after=<last seen id> every few seconds, which is cheap
 * (a few hundred bytes) and needs no Google services.
 */
public class NotifyService extends Service {

    public static final String CH_CALLS = "jarvis_calls";
    public static final String CH_MESSAGES = "jarvis_messages";
    public static final String CH_QUIET = "jarvis_alive";
    public static final String CH_MISSED = "jarvis_missed";
    private static final int ID_ALIVE = 1000;
    private static final int ID_MISSED_BASE = 5000;
    private static final int ID_NOTICE = 4242;
    private static final int ID_CALL = 2000;
    private static final int ID_MSG_BASE = 3000;

    public static volatile boolean foreground = false;   // set by MainActivity

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Thread worker;
    private volatile boolean running = false;
    /** Read by the in-app diagnostics screen: is background delivery actually alive? */
    public static volatile boolean sAlive = false;

    private String token;
    private String ringingFor = null;
    private Ringtone ringtone;
    private Vibrator vibrator;
    private PowerManager.WakeLock wake;

    @Override
    public void onCreate() {
        super.onCreate();
        // A foreground service is the only way Android (and MIUI) lets an app keep a
        // connection while the phone is asleep, so this is what keeps messages and
        // calls arriving instantly. The notification it needs is silent and quiet.
        try { startForeground(ID_ALIVE, aliveNotification()); } catch (Exception ignored) {}
        sAlive = true;
        createChannels();
    }

    /**
     * Android 8+ silently drops a notification whose channel does not exist yet. The
     * service can be started by the boot receiver without the app ever having drawn its
     * UI, so it creates every channel it uses itself — this is why a missed-call
     * notification could previously vanish without a trace.
     */
    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Ringing for voice and video calls");
        calls.enableVibration(true);
        NotificationChannel msgs = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msgs.setDescription("New messages");
        NotificationChannel missed = new NotificationChannel(CH_MISSED, "Missed calls", NotificationManager.IMPORTANCE_HIGH);
        missed.setDescription("Calls you did not pick up");
        NotificationChannel quiet = new NotificationChannel(CH_QUIET, "Stay connected", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        quiet.setSound(null, null);
        quiet.enableVibration(false);
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(msgs);
        nm.createNotificationChannel(missed);
        nm.createNotificationChannel(quiet);
    }

    /** The bare minimum Android requires for a foreground service. No sound, no buzz. */
    private Notification aliveNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH_QUIET, "Stay connected", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 9, open, flags);
        Notification.Builder b = newBuilder(CH_QUIET)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("XCaller is on")
                .setContentText("Messages and calls arrive instantly")
                .setContentIntent(pi)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN);
        return b.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String fromIntent = intent != null ? intent.getStringExtra("token") : null;
        if (fromIntent != null && !fromIntent.isEmpty()) token = fromIntent;
        if (token == null) {
            SharedPreferences sp = getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
            token = sp.getString("token", null);
        }
        // the web view saw a call come in: ring the phone natively right away
        String action = intent != null ? intent.getStringExtra("action") : null;
        try {
            if ("ring".equals(action)) {
                startRinging(intent.getStringExtra("callId"), intent.getStringExtra("fromName"), intent.getStringExtra("kind"));
                return START_STICKY;
            }
            if ("stopring".equals(action)) {
                stopRinging();
                return START_STICKY;
            }
            // the diagnostics screen asks for a real notification: it exercises the
            // channel, the permission and Doze in one tap
            if ("test".equals(action)) {
                showTest("missed".equals(intent.getStringExtra("kind")));
                return START_STICKY;
            }
        } catch (Exception e) {
            // never let a ringing problem take the whole app down
        }
        if (token == null || token.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Restart the listening loop if it died: a killed worker thread used to leave
        // `running` true forever, so the keepalive alarm ticked but did nothing and
        // the phone went silent until the app was reopened.
        startLoopIfDead();
        scheduleKeepAlive();
        return START_STICKY;
    }

    /**
     * Wake up again in a minute. Without a foreground notification Android is free
     * to stop us, so the alarm is what keeps background delivery alive.
     */
    private void scheduleKeepAlive() {
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent again = new Intent(this, NotifyService.class);
            if (token != null) again.putExtra("token", token);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            // getForegroundService (API 26+): a plain getService → startService() from
            // this alarm throws "app is in background" on Android 8+ and was silently
            // swallowed — exactly the state where a killed service never came back and
            // notifications stopped. The service calls startForeground() in onCreate,
            // which satisfies the 5-second foreground requirement.
            PendingIntent pi = Build.VERSION.SDK_INT >= 26
                    ? PendingIntent.getForegroundService(this, 7, again, flags)
                    : PendingIntent.getService(this, 7, again, flags);
            long at = System.currentTimeMillis() + 60_000L;
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi);
            else am.set(android.app.AlarmManager.RTC_WAKEUP, at, pi);
        } catch (Exception ignored) {}
    }

    /** (Re)start the inbox loop only when it is not actually running. */
    private void startLoopIfDead() {
        boolean dead = !running || worker == null || !worker.isAlive();
        if (!dead) return;
        running = false;                       // clear a stale flag from a dead thread
        if (worker != null) worker.interrupt();
        running = true;
        startLoop();
    }

    private void startLoop() {
        worker = new Thread(new Runnable() {
            @Override public void run() {
                long after = 0;
                // start from "now" so we do not replay the whole history on boot
                try {
                    JSONObject first = new JSONObject(Api.get("/inbox?after=999999999", token));
                    after = first.optLong("latestId", 0);
                } catch (Exception ignored) {}

                while (running) {
                    long sleep = 250;
                    try {
                        // Long poll: the server holds this request open and answers the
                        // instant a message, call or notice arrives — no 3-second wait.
                        SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
                        JSONObject inbox = new JSONObject(Api.get("/inbox?after=" + after
                                + "&wait=25&seenNotice=" + prefs.getLong("shownNotice", 0)
                                + "&seenEvent=" + prefs.getLong("shownEvent", 0), token, 40000));
                        long latest = inbox.optLong("latestId", after);
                        JSONArray msgs = inbox.optJSONArray("messages");
                        if (!foreground && msgs != null && msgs.length() > 0) {
                            showMessages(msgs);
                        }
                        if (latest > after) after = latest;

                        JSONObject call = inbox.optJSONObject("call");
                        if (!foreground && call != null) {
                            startRinging(call.optString("callId"), call.optString("fromName"), call.optString("kind"));
                            sleep = 250;                        // back to listening at once
                        } else if (ringingFor != null) {
                            stopRinging();
                        }
                        JSONArray events = inbox.optJSONArray("events");
                        if (events != null && events.length() > 0) showEvents(events);

                        JSONObject notice = inbox.optJSONObject("notice");
                        if (notice != null) {
                            long nid = notice.optLong("id", 0);
                            SharedPreferences sp = getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
                            if (nid > 0 && sp.getLong("shownNotice", 0) < nid) {
                                showNotice(notice.optString("title"), notice.optString("body"), notice.optString("version"));
                                sp.edit().putLong("shownNotice", nid).apply();
                            }
                        }
                    } catch (Exception e) {
                        String m = e.getMessage() == null ? "" : e.getMessage();
                        if (m.contains("401")) {               // session ended: stop until the app is opened again
                            running = false;
                            sAlive = false;
                            break;
                        }
                        sleep = 8000;                          // server unreachable: back off
                    }
                    try { Thread.sleep(sleep); } catch (InterruptedException e) { return; }
                }
            }
        }, "xcaller-inbox");
        worker.setDaemon(true);
        worker.start();
    }

    /* ------------------------------------------------------------ messages -- */

    private void showMessages(JSONArray msgs) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Map<String, StringBuilder> byChat = new HashMap<>();
        Map<String, String> titles = new HashMap<>();
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            if (m == null) continue;
            String chatId = m.optString("chatId");
            String who = m.optString("senderName", m.optString("senderUsername", "Someone"));
            String body = m.optString("body", "");
            String kind = m.optString("kind", "text");
            if (body.isEmpty()) {
                body = kind.equals("image") ? "\uD83D\uDCF7 Photo"
                     : kind.equals("voice") ? "\uD83C\uDFA4 Voice message" : "\uD83D\uDCCE Attachment";
            }
            String shown = (m.optString("chatKind").equals("group") ? who + ": " : "") + body;
            StringBuilder sb = byChat.get(chatId);
            if (sb == null) { sb = new StringBuilder(); byChat.put(chatId, sb); titles.put(chatId, m.optString("chatKind").equals("group") && !m.optString("chatTitle").isEmpty() ? m.optString("chatTitle") : who); }
            if (sb.length() > 0) sb.append("\n");
            sb.append(shown);
        }
        int n = 0;
        for (Map.Entry<String, StringBuilder> e : byChat.entrySet()) {
            String chatId = e.getKey();
            Intent open = new Intent(this, MainActivity.class);
            open.putExtra("open", chatId);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getActivity(this, ID_MSG_BASE + Math.abs(chatId.hashCode() % 500), open, flags);

            Notification.Builder b = newBuilder(CH_MESSAGES)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(titles.get(chatId))
                    .setContentText(e.getValue().toString())
                    .setStyle(new Notification.BigTextStyle().bigText(e.getValue().toString()))
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setPriority(Notification.PRIORITY_HIGH);
            if (Build.VERSION.SDK_INT >= 21) b.setCategory(Notification.CATEGORY_MESSAGE);
            nm.notify(ID_MSG_BASE + Math.abs(chatId.hashCode() % 500), b.build());
            n++;
        }
        if (n > 0) vibrate(new long[]{0, 120, 90, 120}, -1);
    }

    /* --------------------------------------------------------------- calls -- */

    private void startRinging(String callId, String fromName, String kind) {
        if (callId == null || callId.isEmpty() || callId.equals(ringingFor)) return;
        ringingFor = callId;

        // Two different intents on purpose.
        //   openIntent   → opens the app on the ringing screen. No auto-answer. This is what
        //                  the notification body AND the full-screen intent use.
        //   answerIntent → carries `explicitAnswer`, so only a deliberate tap on the Answer
        //                  action can pick the call up.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        PendingIntent openPi = PendingIntent.getActivity(this, 99, openIntent, flags);

        Intent answerIntent = new Intent(this, MainActivity.class);
        answerIntent.putExtra("answer", callId);
        answerIntent.putExtra("explicitAnswer", true);
        answerIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        PendingIntent answerPi = PendingIntent.getActivity(this, 98, answerIntent, flags);

        Notification.Builder b = newBuilder(CH_CALLS)
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setContentTitle((kind != null && kind.equals("video") ? "Video call" : "Voice call") + " from " + (fromName == null ? "someone" : fromName))
                .setContentText("Open to see the call · Answer to pick up")
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(openPi)
                .setPriority(Notification.PRIORITY_MAX)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        if (Build.VERSION.SDK_INT >= 21) {
            b.setCategory(Notification.CATEGORY_CALL);
            b.setFullScreenIntent(openPi, true);          // shows the ringing screen, never answers
            b.addAction(new Notification.Action.Builder(
                    android.R.drawable.ic_menu_call, "Answer", answerPi).build());
        }
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(ID_CALL, b.build());

        try {
            Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (ring == null) ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            ringtone = RingtoneManager.getRingtone(this, ring);
            if (Build.VERSION.SDK_INT >= 21) {
                ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            }
            ringtone.play();
        } catch (Exception ignored) {}
        vibrate(new long[]{0, 700, 700}, 0);

        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:call");
            wake.acquire(90 * 1000);
        } catch (Exception ignored) {}
    }

    private void stopRinging() {
        ringingFor = null;
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).cancel(ID_CALL);
        try { if (ringtone != null) { ringtone.stop(); ringtone = null; } } catch (Exception ignored) {}
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) {}
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) {}
    }

    /** "Missed call from …" — shown once per event id, awake or asleep. */
    private void showEvents(JSONArray events) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        SharedPreferences sp = getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        long shown = sp.getLong("shownEvent", 0);
        long newest = shown;
        for (int i = 0; i < events.length(); i++) {
            JSONObject ev = events.optJSONObject(i);
            if (ev == null) continue;
            long id = ev.optLong("id", 0);
            if (id <= shown) continue;
            String kind = ev.optString("kind", "");
            if (!"missed_call".equals(kind)) { if (id > newest) newest = id; continue; }
            JSONObject extra = ev.optJSONObject("extra");
            String from = extra != null ? extra.optString("fromName", "") : "";
            String callKind = extra != null ? extra.optString("kind", "video") : "video";
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (extra != null) open.putExtra("open", extra.optString("chatId", ""));
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getActivity(this, ID_MISSED_BASE + (int) (id % 500), open, flags);
            int callId = (int) (id % 500);
            showCallNotification(pi, callId, from, callKind);
            if (id > newest) newest = id;
        }
        if (newest > shown) sp.edit().putLong("shownEvent", newest).apply();
    }

    /**
     * Android 14 refuses any activity start from the background, so a ringing screen
     * cannot be forced open — but a full-screen-intent notification is exactly the
     * mechanism Android provides for it, and the system opens it on the lock screen.
     */
    private void showCallNotification(PendingIntent pi, int callId, String from, String kind) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        try {
            Notification.Builder b = newBuilder(CH_MISSED)
                    .setSmallIcon(android.R.drawable.sym_action_call)
                    .setContentTitle("Missed " + ("video".equals(kind) ? "video" : "voice") + " call")
                    .setContentText((from == null || from.isEmpty() ? "Someone" : from))
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setTimeoutAfter(60 * 60 * 1000L);
            if (Build.VERSION.SDK_INT >= 21) b.setCategory(Notification.CATEGORY_MISSED_CALL);
            nm.notify(ID_MISSED_BASE + callId, b.build());
        } catch (Exception ignored) {}
    }

    /** "A new version of XCaller is available" — tap to open the app and update. */
    /** A real notification on the real channels — the same path a message takes. */
    private void showTest(boolean missed) {
        try {
            createChannels();
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(this, missed ? 9101 : 9100, open, flags);
            String channel = missed ? CH_MISSED : CH_MESSAGES;
            String title = missed ? "XCaller test: missed call" : "XCaller test";
            String body = missed ? "If you can read this on your lock screen, missed-call alerts work." : "If you can read this, message alerts work.";
            Notification.Builder b = newBuilder(channel)
                    .setSmallIcon(missed ? android.R.drawable.sym_action_call : android.R.drawable.sym_action_chat)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            if (Build.VERSION.SDK_INT >= 16) b.setPriority(missed ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(missed ? 9101 : 9100, b.build());
        } catch (Exception ignored) { }
    }

    private void showNotice(String title, String body, String version) {
        try {
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            open.putExtra("update", "1");        // tap = download + open installer immediately
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getActivity(this, 77, open, flags);
            // A direct "Update now" button on the notification itself: one tap, download starts,
            // installer opens when finished. No app-opening, no modal-hunting.
            PendingIntent nowPi = PendingIntent.getActivity(this, 78, open, flags);
            Notification.Builder b = newBuilder(CH_MESSAGES)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle(title == null || title.isEmpty() ? "XCaller update" : title)
                    .setContentText(body == null ? "" : body)
                    .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .addAction(new Notification.Action.Builder(android.R.drawable.stat_sys_download, "Update now", nowPi).build())
                    .setPriority(Notification.PRIORITY_HIGH);
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(ID_NOTICE, b.build());
        } catch (Exception ignored) {}
    }

    private void vibrate(long[] pattern, int repeat) {
        try {
            if (vibrator == null) vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, repeat));
            else vibrator.vibrate(pattern, repeat);
        } catch (Exception ignored) {}
    }

    /* -------------------------------------------------------------- plumbing */

    @SuppressWarnings("deprecation")
    private Notification.Builder newBuilder(String channel) {
        if (Build.VERSION.SDK_INT >= 26) return new Notification.Builder(this, channel);
        return new Notification.Builder(this);
    }

    @Override
    public void onDestroy() {
        sAlive = false;
        running = false;
        stopRinging();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
