package com.jarvis.chat;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/** The tiny bit of HTTP the background service needs. */
final class Api {

    static final String BASE = Server.DEFAULT_URL + "api";

    private Api() {}

    static String get(String path, String token) throws Exception {
        return call("GET", path, null, token, 8000, 12000);
    }

    /** For long-polling: the server may hold the request open until something happens. */
    static String get(String path, String token, int readTimeoutMs) throws Exception {
        return call("GET", path, null, token, 8000, readTimeoutMs);
    }

    /** POST a small JSON body. Used by the crash reporter. */
    static String post(String path, String json, String token, int timeoutMs) throws Exception {
        return call("POST", path, json, token, timeoutMs, timeoutMs);
    }

    private static String call(String method, String path, String json, String token, int connectMs, int readMs) throws Exception {
        if (path.startsWith("/api/")) path = path.substring(4);      // guard against a double prefix
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE + path).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "XCaller-Android/1.6");
            if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
            if (json != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] out = json.getBytes("UTF-8");
                c.setFixedLengthStreamingMode(out.length);
                c.getOutputStream().write(out);
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) throw new Exception("HTTP " + code);
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            if (code >= 400) throw new Exception("HTTP " + code + ": " + sb);
            return sb.toString();
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
