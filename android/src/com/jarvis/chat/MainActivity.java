package com.jarvis.chat;

import android.os.Build;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.Manifest;
import android.content.pm.PackageManager;

/**
 * XCaller for Android.
 *
 * The messenger itself is the same web app the server serves; this shell adds what
 * a browser tab cannot do: the microphone/camera are granted for good, uploads work,
 * and a small foreground service keeps a connection so messages and calls reach you
 * while the app is in the background — with a proper full-screen ringing screen.
 */
public class MainActivity extends Activity {

    public static final String APP_URL = Server.DEFAULT_URL;
    public static final String PREFS = "jarvis";
    public static final String VERSION_NAME = "3.14";
    private static final int FILE_PICK = 4711;

    private WebView web;
    private android.widget.FrameLayout root;
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCb;
    private ValueCallback<Uri[]> pendingFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        installCrashReporter();
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        createNotificationChannels();
        try {
            android.content.IntentFilter hs = new android.content.IntentFilter();
            hs.addAction(android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            hs.addAction(android.bluetooth.BluetoothAdapter.ACTION_CONNECTION_STATE_CHANGED);
            hs.addAction(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(hsReceiver, hs, Context.RECEIVER_EXPORTED);
            else registerReceiver(hsReceiver, hs);
        } catch (Exception ignored) { }
        askPermissions();
        askStayAwake();

        root = new android.widget.FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        web.setBackgroundColor(0xFF0D0D12);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // so calls can start ringing/playing
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        String ver;
        try {
            ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ePkg) {
            ver = "3.10";   // fallback if package lookup fails
        }
        s.setUserAgentString(s.getUserAgentString() + " XCallerApp/" + ver);
        CookieManager.getInstance().setAcceptCookie(true);
        try { web.addJavascriptInterface(new Bridge(), "XCApp"); } catch (Exception ignored) {}

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith(APP_URL)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                syncTokenToService();
                purgeStaleCacheOnce(view, url);
                // Deep links (?open=/?answer=) and update-purge reloads used to leave
                // stale navigation entries behind. Drop them after a clean load so the
                // back stack reflects reality.
                if (url != null && url.startsWith(APP_URL) && !url.contains("?")) view.clearHistory();
            }
        });

        web.getSettings().setTextZoom(100); // ignore system font scale so header text never clips

        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override public void onDownloadStart(String url, String ua, String cd, String mt, long len) {
                if (url != null && url.contains("XCaller.apk")) { downloadUpdate(url); return; }
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // HTML5 fullscreen, so a video call really fills the screen
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullView != null) { callback.onCustomViewHidden(); return; }
                fullView = view;
                fullCb = callback;
                view.setBackgroundColor(0xFF0D0D12);
                root.addView(view, new android.widget.FrameLayout.LayoutParams(
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                applyImmersive(true);
            }
            @Override
            public void onHideCustomView() {
                if (fullView == null) return;
                root.removeView(fullView);
                fullView = null;
                web.setVisibility(View.VISIBLE);
                applyImmersive(false);
                if (fullCb != null) { fullCb.onCustomViewHidden(); fullCb = null; }
            }
            // calling needs the camera and the mic: grant whatever the page asks for
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { request.grant(request.getResources()); }
                });
            }
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                pendingFile = cb;
                try {
                    Intent pick = params.createIntent();
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(pick, FILE_PICK);
                    return true;
                } catch (Exception e) {
                    pendingFile = null;
                    return false;
                }
            }
        });

        String url = APP_URL;
        Intent intent = getIntent();
        if (intent != null && intent.getStringExtra("answer") != null) {
            url = APP_URL + "?answer=" + Uri.encode(intent.getStringExtra("answer"));
        }
        web.loadUrl(url);
        handleIntent(intent);
    }

    /** One-shot: after an app update, wipe stale service workers + HTTP cache so the
     *  WebView can never render a days-old UI (root cause of "UI is still same").
     *  Touches caches only — login (localStorage) is preserved. */
    private void purgeStaleCacheOnce(final WebView view, String url) {
        if (url == null || !url.startsWith(APP_URL)) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if ("purged".equals(sp.getString("cachepurge", ""))) return;
            sp.edit().putString("cachepurge", "purged").apply();
            if (Build.VERSION.SDK_INT >= 21) view.clearCache(true);
            view.clearFormData();
            view.evaluateJavascript(
                "(function(){try{" +
                "if(navigator.serviceWorker){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});}" +
                "if(window.caches){caches.keys().then(function(ks){ks.forEach(function(n){caches.delete(n);});});}" +
                "}catch(e){}})();", null);
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override public void run() {
                    if (web != null) web.loadUrl(APP_URL);
                }
            }, 600);
        } catch (Exception ignored) { }
    }

    /** A notification tap either answers a call or opens the chat list. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        final String answer = intent.getStringExtra("answer");
        final String open = intent.getStringExtra("open");
        final String upd = intent.getStringExtra("update");
        if (upd != null) {
            // Update notification tapped: download the new APK and open the installer
            // right away — the user should never have to hunt for a button.
            downloadUpdate(APP_URL.replace("/chat/", "") + "/chat/XCaller.apk");
            return;
        }
        if (answer == null && open == null) return;
        if (web == null) return;
        // Only a deliberate "Answer" tap may join a call. The ring notification's body and
        // its full-screen intent carry no `explicitAnswer`, so a call can never be picked up
        // by the app opening (which is what made calls answer themselves on a locked phone).
        boolean explicit = intent.getBooleanExtra("explicitAnswer", false);
        if (answer != null && explicit) {
            web.evaluateJavascript("(function(){try{if(window.Calls&&window.Calls.accept){window.Calls.accept('" + answer + "');return 'ok';}}catch(e){}return 'later';})()", null);
            // if the app was cold, the deep link is handled when the page loads
            web.postDelayed(new Runnable() {
                @Override public void run() {
                    if (web != null) web.loadUrl(APP_URL + "?answer=" + Uri.encode(answer) + "&picked=1");
                }
            }, 4000);
            return;
        }
        if (open != null) {
            // Ask the web app to open the chat; it parks the request if the list has
            // not loaded yet. If the page is not ready at all (cold start), reload it
            // with the ?open= deep link so the app applies it right after login.
            web.evaluateJavascript("window.XCOpen?String(window.XCOpen('" + open + "')):'none'",
                new ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) {
                        if (value == null || value.contains("none")) {
                            web.loadUrl(APP_URL + "?open=" + Uri.encode(open));
                        }
                    }
                });
        }
    }

    /** Read the session token out of the web app's storage and hand it to the service. */
    private void syncTokenToService() {
        web.evaluateJavascript("(function(){try{return localStorage.getItem('jarvis.token')||'';}catch(e){return '';}})()", new ValueCallback<String>() {
            @Override public void onReceiveValue(String value) {
                String token = value == null ? "" : value.replace("\"", "");
                SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                if (token.isEmpty()) {
                    sp.edit().remove("token").apply();
                    stopService(new Intent(MainActivity.this, NotifyService.class));
                    return;
                }
                sp.edit().putString("token", token).apply();
                try {
                    Intent svc = new Intent(MainActivity.this, NotifyService.class);
                    svc.putExtra("token", token);
                    // Foreground service: the only way Android keeps listening while the
                    // phone sleeps. Started from the visible app, which is always allowed.
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
                } catch (Exception e) {
                    // Android only lets an app start a service while it is visible.
                    // Starting it from the background used to crash the app — now we
                    // simply wait until the app is in the foreground again.
                }
            }
        });
    }

    /**
     * Any crash (including one during start-up) is sent to our own server, so it
     * can be read and fixed without a cable or a screenshot.
     */
    private void installCrashReporter() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread thread, Throwable error) {
                try { Crash.report(thread, error); } catch (Throwable ignored) {}
                try {
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                            .putString("last_crash", String.valueOf(error)).apply();
                } catch (Throwable ignored) {}
                if (previous != null) previous.uncaughtException(thread, error);
            }
        });
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel calls = new NotificationChannel(NotifyService.CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Ringing for voice and video calls");
        calls.enableVibration(true);
        calls.setBypassDnd(true);
        NotificationChannel msgs = new NotificationChannel(NotifyService.CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel missed = new NotificationChannel(NotifyService.CH_MISSED, "Missed calls", NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel quiet = new NotificationChannel(NotifyService.CH_QUIET, "Stay connected", NotificationManager.IMPORTANCE_MIN);
        quiet.setShowBadge(false);
        quiet.setSound(null, null);
        quiet.enableVibration(false);
        msgs.setDescription("New messages");
        missed.setDescription("Calls you did not pick up");
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(msgs);
        nm.createNotificationChannel(missed);
        nm.createNotificationChannel(quiet);
    }

    /**
     * On Android 12+/MIUI the phone suspends background apps unless they are exempt
     * from battery optimisation. Ask once, with the system dialog, on first launch.
     */
    private void askStayAwake() {
        try {
            if (Build.VERSION.SDK_INT < 23) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (sp.getBoolean("askedBattery", false)) return;
            sp.edit().putBoolean("askedBattery", true).apply();
            Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) { }
    }

    /**
     * Earpiece or loudspeaker during a call. Two routes are used because devices
     * disagree: the modern communication-device API on Android 12+, and the older
     * speakerphone flag everywhere (some WebView builds only respect the flag).
     */
    private boolean hasAudioFocus = false;
    private final AudioManager.OnAudioFocusChangeListener focusListener =
            new AudioManager.OnAudioFocusChangeListener() {
                @Override public void onAudioFocusChange(int change) { /* the OS handles duck/restore */ }
            };

    /**
     * Where the call's sound comes out — and, more importantly, which stream it travels on.
     *
     * WebView/WebRTC plays the call on the MEDIA stream. Putting the phone into
     * MODE_IN_COMMUNICATION and pointing it at the earpiece routes that media into the
     * voice-call stream, which on most devices is silent for anything that is not a real
     * telephony call — the call connects and nobody hears anybody. So: loudspeaker keeps
     * the phone in MODE_NORMAL (media stays audible), and only an explicit switch to the
     * earpiece uses communication mode, with the earpiece selected as the device.
     */
    /** Any Bluetooth audio device currently attached (headset profile or SCO call channel). */
    private boolean btAudioConnected(AudioManager am) {
        try {
            if (am.isBluetoothScoOn()) return true;
            if (Build.VERSION.SDK_INT >= 31) {
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    int t = d.getType();
                    if (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return true;
                }
            }
            for (android.media.AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int t = d.getType();
                if (t == 7 /* TYPE_BLUETOOTH_A2DP */ || t == 6 /* TYPE_BLUETOOTH_SCO */) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    private volatile boolean lastSpeakerWanted = true;
    private volatile boolean callActive = false;

    /** Re-apply the route the moment a headset connects or disconnects mid-call. */
    private final android.content.BroadcastReceiver hsReceiver = new android.content.BroadcastReceiver() {
        @Override public void onReceive(Context c, android.content.Intent i) {
            if (!callActive) return;
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) routeAudio(lastSpeakerWanted);
        }
    };

    private String routeAudio(boolean speakerOn) {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return "no audio service";
            lastSpeakerWanted = speakerOn;
            try { am.stopBluetoothSco(); am.setBluetoothScoOn(false); } catch (Exception ignored) { }
            // A paired headset is always preferred over both speaker and earpiece:
            // media plays on it automatically (speaker choice), or via the call
            // channel when the user picked the earpiece.
            boolean bt = btAudioConnected(am);
            if (bt && speakerOn) {
                am.setMode(AudioManager.MODE_NORMAL);
                am.setSpeakerphoneOn(false);
                return "bluetooth · media stream";
            }
            if (bt) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                boolean routed = false;
                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                            if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) { am.setCommunicationDevice(d); routed = true; break; }
                        }
                    } catch (Exception ignored) { }
                }
                if (!routed) { try { am.startBluetoothSco(); am.setBluetoothScoOn(true); } catch (Exception ignored) { } }
                am.setSpeakerphoneOn(false);
                return "bluetooth · communication stream";
            }
            if (speakerOn) {
                if (Build.VERSION.SDK_INT >= 31) {
                    try { am.clearCommunicationDevice(); } catch (Exception ignored) { }
                }
                am.setMode(AudioManager.MODE_NORMAL);
                am.setSpeakerphoneOn(true);
                return "speaker · media stream";
            }
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                        if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) { am.setCommunicationDevice(d); break; }
                    }
                } catch (Exception ignored) { }
            }
            am.setSpeakerphoneOn(false);
            return "earpiece · communication stream";
        } catch (Exception e) {
            return "route failed: " + e.getMessage();
        }
    }

    /**
     * Ask for audio focus while a call is live. Without it the system is free to duck or
     * suspend our playback, and nothing in the app can tell the difference between that
     * and a broken connection.
     */
    private void grabAudioFocus() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            int r = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            hasAudioFocus = (r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        } catch (Exception ignored) { }
    }

    private void dropAudioFocus() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null && hasAudioFocus) am.abandonAudioFocus(focusListener);
        } catch (Exception ignored) { }
        hasAudioFocus = false;
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(hsReceiver); } catch (Exception ignored) { }
        super.onDestroy();
    }

    private void askPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        java.util.List<String> w = new java.util.ArrayList<>();
        w.add(Manifest.permission.CAMERA);
        w.add(Manifest.permission.RECORD_AUDIO);
        w.add(Manifest.permission.POST_NOTIFICATIONS);
        w.add(Manifest.permission.MODIFY_AUDIO_SETTINGS);
        if (Build.VERSION.SDK_INT >= 31) w.add(Manifest.permission.BLUETOOTH_CONNECT);
        String[] wanted = w.toArray(new String[0]);
        boolean need = false;
        for (String p : wanted) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) { need = true; break; }
        }
        if (need) requestPermissions(wanted, 1001);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_PICK) {
            if (pendingFile != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        result = new Uri[]{ data.getData() };
                    }
                }
                pendingFile.onReceiveValue(result);
                pendingFile = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        // the page decides first: leave a call, close a chat, close a popup …
        web.evaluateJavascript(
                "(function(){try{return (window.XCBack && window.XCBack())?'handled':'exit';}catch(e){return 'exit';}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        String v = value == null ? "" : value.replace("\"", "");
                        if ("handled".equals(v)) return;
                        // Nothing left to close: exit NOW. The old fall-through to
                        // web.goBack() made back burn stale navigation entries one
                        // press at a time (7-8 presses before the app would close).
                        // The foreground service keeps running, so messages and
                        // calls keep arriving while the app is exited.
                        finish();
                    }
                });
    }

    /** Real full screen: hide the status and navigation bars while a call is up. */
    private void applyImmersive(boolean on) {
        View d = getWindow().getDecorView();
        if (on) {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    /** The only things the page may ask the shell to do. */
    public class Bridge {
        @android.webkit.JavascriptInterface
        public void fullscreen(final String on) {
            runOnUiThread(new Runnable() {
                @Override public void run() { applyImmersive("on".equals(on)); }
            });
        }

        /** The web socket saw an incoming call: ring natively too, so the phone
         *  rings even when the app is not in the foreground. */
        @android.webkit.JavascriptInterface
        public void ringCall(final String callId, final String fromName, final String kind) {
            try {
                Intent i = new Intent(MainActivity.this, NotifyService.class);
                i.putExtra("action", "ring");
                i.putExtra("callId", callId);
                i.putExtra("fromName", fromName);
                i.putExtra("kind", kind);
                startService(i);                      // the service is usually already alive
            } catch (Exception e) {
                try {
                    Intent i2 = new Intent(MainActivity.this, NotifyService.class);
                    i2.putExtra("action", "ring");
                    i2.putExtra("callId", callId);
                    i2.putExtra("fromName", fromName);
                    i2.putExtra("kind", kind);
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(i2); else startService(i2);
                } catch (Exception ignored) {}
            }
        }

        /**
         * Enter call audio state. Called by the calls engine the moment a call starts or is
         * answered: takes audio focus and starts on the loudspeaker, which is the only route
         * a WebView call is guaranteed to be audible on.
         */
        @android.webkit.JavascriptInterface
        public String startCallAudio() {
            final String[] out = new String[] { "pending" };
            try {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        grabAudioFocus();
                        callActive = true;
                        out[0] = routeAudio(true);
                    }
                });
                Thread.sleep(300);
            } catch (Exception ignored) { }
            return out[0];
        }

        /** Where the call's sound comes out, and where it actually landed. */
        @android.webkit.JavascriptInterface
        public String setSpeaker(final boolean on) {
            final String[] out = new String[] { "pending" };
            try {
                runOnUiThread(new Runnable() { public void run() { out[0] = routeAudio(on); } });
                Thread.sleep(250);
            } catch (Exception ignored) { }
            return out[0];
        }

        /** The call ended: hand the phone's audio back to Android. */
        @android.webkit.JavascriptInterface
        public void endCallAudio() {
            runOnUiThread(new Runnable() { public void run() {
                callActive = false;
                try {
                    dropAudioFocus();
                    AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    if (am == null) return;
                    if (Build.VERSION.SDK_INT >= 31) { try { am.clearCommunicationDevice(); } catch (Exception ignored) { } }
                    am.setSpeakerphoneOn(false);
                    am.setMode(AudioManager.MODE_NORMAL);
                } catch (Exception ignored) { }
            }});
        }

        /** Is the phone itself refusing to show our notifications? Android 13+ asks the user. */
        @android.webkit.JavascriptInterface
        public boolean notificationsBlocked() {
            try {
                if (Build.VERSION.SDK_INT < 24) return false;
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                return nm != null && !nm.areNotificationsEnabled();
            } catch (Exception e) { return false; }
        }

        /** The system's own switch for this app's notifications. */
        @android.webkit.JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    Intent i = new Intent("android.settings.APP_NOTIFICATION_SETTINGS");
                    i.putExtra("android.provider.extra.APP_PACKAGE", getPackageName());
                    i.putExtra("app_package", getPackageName());
                    i.putExtra("app_uid", getApplicationInfo().uid);
                    startActivity(i);
                } catch (Exception e) {
                    try { startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { }
                }
            }});
        }

        /** Where the phone decides whether a background app is allowed to stay alive. */
        @android.webkit.JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                } catch (Exception e) {
                    try { startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS)); } catch (Exception ignored) { }
                }
            }});
        }

        /**
         * MIUI (Xiaomi/Redmi/Poco) has its own "Autostart" switch — without it the phone
         * kills this app's background service no matter what Android itself allows.
         */
        @android.webkit.JavascriptInterface
        public void openAutostartSettings() {
            runOnUiThread(new Runnable() { public void run() {
                String[][] cands = new String[][] {
                    { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
                    { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
                    { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
                    { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
                    { "com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity" },
                    { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" },
                };
                for (String[] c : cands) {
                    try {
                        Intent i = new Intent();
                        i.setClassName(c[0], c[1]);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                        return;
                    } catch (Exception ignored) { }
                }
                try { startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { }
            }});
        }

        @android.webkit.JavascriptInterface
        public void stopRing() {
            try {
                Intent i = new Intent(MainActivity.this, NotifyService.class);
                i.putExtra("action", "stopring");
                startService(i);
            } catch (Exception ignored) {}
        }

        /** Download the new APK; Android then offers to install it over this one. */
        /**
         * What the phone itself says. Everything here was previously only
         * checkable by holding the device, so the app can now show it and the
         * user can send one line back when something is off.
         */
        @android.webkit.JavascriptInterface
        public String diag() {
            org.json.JSONObject o = new org.json.JSONObject();
            try {
                android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                o.put("appVersion", pi.versionName);
                o.put("appBuild", pi.versionCode);
                o.put("android", android.os.Build.VERSION.RELEASE);
                o.put("sdk", android.os.Build.VERSION.SDK_INT);
            } catch (Exception ignored) { }
            try {
                String ua = web == null ? "" : web.getSettings().getUserAgentString();
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("(Chrome/[0-9.]+)").matcher(ua);
                o.put("webView", m.find() ? m.group(1) : "unknown");
            } catch (Exception ignored) { }
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                o.put("notifications", nm != null && nm.areNotificationsEnabled() ? "allowed" : "BLOCKED");
            } catch (Exception ignored) { }
            try {
                if (android.os.Build.VERSION.SDK_INT >= 33) {
                    o.put("permission", checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED ? "granted" : "NOT granted");
                } else { o.put("permission", "not needed"); }
            } catch (Exception ignored) { }
            try { o.put("background", NotifyService.sAlive ? "service running" : "service NOT running"); } catch (Exception ignored) { }
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                o.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(getPackageName()) ? "unrestricted" : "may be frozen when idle");
            } catch (Exception ignored) { }
            try {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    o.put("installs", getPackageManager().canRequestPackageInstalls() ? "allowed" : "NOT allowed");
                } else { o.put("installs", "allowed"); }
            } catch (Exception ignored) { }
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    o.put("audioRoute", am.isSpeakerphoneOn() ? "speaker" : "earpiece/receiver");
                    o.put("audioMode", am.getMode() == AudioManager.MODE_NORMAL ? "normal (media)" : ("mode " + am.getMode()));
                    o.put("audioFocus", hasAudioFocus ? "held" : "not held");
                    if (android.os.Build.VERSION.SDK_INT >= 31) {
                        try {
                            AudioDeviceInfo d = am.getCommunicationDevice();
                            o.put("commDevice", d == null ? "none" : String.valueOf(d.getType()));
                        } catch (Exception ignored) { }
                    }
                    o.put("ringVolume", am.getStreamVolume(AudioManager.STREAM_RING) + "/" + am.getStreamMaxVolume(AudioManager.STREAM_RING));
                }
            } catch (Exception ignored) { }
            return o.toString();
        }

        /** Fire a real notification through the service, so the channel, the
         *  permission and Doze are all exercised at once. */
        @android.webkit.JavascriptInterface
        public String testNotify(final String kind) {
            try {
                Intent i = new Intent(MainActivity.this, NotifyService.class);
                i.putExtra("action", "test");
                i.putExtra("kind", "missed".equals(kind) ? "missed" : "msg");
                startService(i);
                return "missed".equals(kind) ? "Test missed call sent" : "Test notification sent";
            } catch (Exception e) {
                try {
                    Intent i2 = new Intent(MainActivity.this, NotifyService.class);
                    i2.putExtra("action", "test");
                    i2.putExtra("kind", "missed".equals(kind) ? "missed" : "msg");
                    startService(i2);
                    return "Test sent (service restarted)";
                } catch (Exception e2) {
                    return "Could not send: " + e2.getMessage();
                }
            }
        }

        /** Flip the call audio route and report where it actually landed. */
        @android.webkit.JavascriptInterface
        public String testSpeaker() {
            final String[] out = new String[] { "no audio service" };
            try {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try {
                            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                            if (am == null) return;
                            boolean want = !am.isSpeakerphoneOn();
                            routeAudio(want);
                            out[0] = want ? "switched to speaker" : "switched to earpiece";
                        } catch (Exception e) { out[0] = "failed: " + e.getMessage(); }
                    }
                });
                Thread.sleep(400);
            } catch (Exception ignored) { }
            return out[0];
        }

        @android.webkit.JavascriptInterface
        public void installApk(final String url) {
            runOnUiThread(new Runnable() {
                @Override public void run() { downloadUpdate(url); }
            });
        }
    }

    private long lastDownloadId = -1;
    private android.os.Handler dlHandler;
    private String dlUrl = "";

    /**
     * Download the new APK and then open the installer ourselves.
     *
     * This used to rely on DownloadManager's completion notification ("tap the finished download
     * to install"). If notifications are turned off for the app — which is exactly the state of
     * most phones that need an update — that notification never appears, so tapping Update looked
     * like it did nothing at all. So: watch the download here, and open the system installer the
     * moment it finishes. No notification, no "open it from Downloads" step.
     */
    private void downloadUpdate(String url) {
        dlUrl = url;
        try {
            String name = "XCaller-update-" + System.currentTimeMillis() + ".apk";
            android.app.DownloadManager dm = (android.app.DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            android.app.DownloadManager.Request rq =
                    new android.app.DownloadManager.Request(android.net.Uri.parse(url));
            rq.setTitle("XCaller update");
            rq.setDescription("Downloading the new version — your chats and call history stay intact");
            rq.setMimeType("application/vnd.android.package-archive");
            rq.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE);
            rq.setDestinationInExternalFilesDir(this, null, name);
            lastDownloadId = dm.enqueue(rq);
            toastOnUi("Downloading the update…");
            pollDownload(lastDownloadId, 0);
        } catch (Exception e) {
            toastOnUi("Could not start the download — opening the link in your browser");
            try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))); } catch (Exception e2) {}
        }
    }

    /** Watch the download and install as soon as it is done (about every 800 ms, max ~2 min). */
    private void pollDownload(final long id, final int tries) {
        if (dlHandler == null) dlHandler = new android.os.Handler(getMainLooper());
        if (id < 0 || tries > 150) return;
        dlHandler.postDelayed(new Runnable() {
            @Override public void run() {
                android.app.DownloadManager dm = (android.app.DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                android.database.Cursor c = null;
                try {
                    c = dm.query(new android.app.DownloadManager.Query().setFilterById(id));
                    if (c != null && c.moveToFirst()) {
                        int status = c.getInt(c.getColumnIndex(android.app.DownloadManager.COLUMN_STATUS));
                        int reason = c.getInt(c.getColumnIndex(android.app.DownloadManager.COLUMN_REASON));
                        if (status == android.app.DownloadManager.STATUS_SUCCESSFUL) {
                            toastOnUi("Update downloaded — opening the installer");
                            openInstaller(dm.getUriForDownloadedFile(id));
                            return;
                        }
                        if (status == android.app.DownloadManager.STATUS_FAILED) {
                            toastOnUi("Download failed (code " + reason + ") — opening the link in your browser");
                            try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(dlUrl))); } catch (Exception e) {}
                            return;
                        }
                    }
                } catch (Exception e) {
                } finally { if (c != null) c.close(); }
                pollDownload(id, tries + 1);
            }
        }, 800);
    }

    /** Hand the downloaded file to Android's own installer screen. */
    private void openInstaller(android.net.Uri uri) {
        if (uri == null) {
            toastOnUi("Update downloaded, but Android would not hand it over — open the link in your browser");
            try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(dlUrl))); } catch (Exception e) {}
            return;
        }
        try {
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
        } catch (Exception e) {
            toastOnUi("Could not open the installer — the file is in this app's Downloads folder");
        }
    }

    private void toastOnUi(final String msg) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        NotifyService.foreground = true;
        if (web != null) web.onResume();
        // tell the server the screen is really open (green dot = realtime)
        if (web != null) web.evaluateJavascript("window.XCPresenceVisible && XCPresenceVisible(true)", null);
        syncTokenToService();
    }

    @Override
    protected void onPause() {
        super.onPause();
        NotifyService.foreground = false;
        // screen closed but app alive in background: user must NOT look online
        if (web != null) web.evaluateJavascript("window.XCPresenceVisible && XCPresenceVisible(false)", null);
    }
}
