package com.jarvis.chat;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * Reports a crash to our own server so it can be fixed without a cable and
 * without asking the user to copy anything out of a dialog.
 */
final class Crash {

    private Crash() {}

    /** Sends the stack trace to the server. Never throws, never blocks for long. */
    static void report(Thread thread, Throwable error) {
        try {
            StringWriter sw = new StringWriter();
            error.printStackTrace(new PrintWriter(sw));
            String trace = sw.toString();
            if (trace.length() > 6000) trace = trace.substring(0, 6000);
            String body = "{"
                    + "\"thread\":\"" + esc(String.valueOf(thread)) + "\","
                    + "\"version\":\"" + esc(MainActivity.VERSION_NAME) + "\","
                    + "\"android\":\"" + esc(android.os.Build.VERSION.RELEASE + " (" + android.os.Build.VERSION.SDK_INT + ") " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL) + "\","
                    + "\"error\":\"" + esc(String.valueOf(error.getClass().getName() + ": " + error.getMessage())) + "\","
                    + "\"trace\":\"" + esc(trace) + "\""
                    + "}";
            Api.post("/crash", body, null, 4000);
        } catch (Throwable ignored) {}
    }

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(' ');
                    else b.append(c);
            }
        }
        return b.toString();
    }
}
