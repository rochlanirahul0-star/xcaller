package com.jarvis.chat;

/**
 * The server this build talks to.
 *
 * The repository deliberately contains no address. build.sh injects
 * XC_SERVER_URL into this constant at build time; self-hosters point it at their
 * own HTTPS origin, and the official release is built with its own endpoint.
 * Keep the trailing slash.
 */
final class Server {
    static final String DEFAULT_URL = "__XC_SERVER_URL__";
    private Server() {}
}
