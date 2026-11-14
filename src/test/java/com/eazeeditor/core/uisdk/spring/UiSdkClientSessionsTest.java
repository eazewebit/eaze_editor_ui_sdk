package com.eazeeditor.core.uisdk.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Routing rules of {@link UiSdkClientSessions} — the table that decides which disconnect is fatal for a
 * window and which one is merely an old socket being cleaned up after a reconnect.  Plain JUnit: the class is
 * Spring-free on purpose, so these rules are checked without a broker.
 */
class UiSdkClientSessionsTest {

   @Test
   @DisplayName("a SUBSCRIBE binds the socket to its window")
   void bindTracksSessionAndWindow() {
      UiSdkClientSessions sessions = new UiSdkClientSessions();

      sessions.bind("browser-1", "session-a");

      assertEquals("browser-1", sessions.clientIdOf("session-a"));
      assertEquals(1, sessions.trackedSessions());
   }

   @Test
   @DisplayName("losing the last socket of a window is what reports it gone")
   void closingTheBoundSessionReportsTheWindow() {
      UiSdkClientSessions sessions = new UiSdkClientSessions();
      sessions.bind("browser-1", "session-a");

      assertEquals("browser-1", sessions.onSessionClosed("session-a"));
      assertNull(sessions.clientIdOf("session-a"));
      assertEquals(0, sessions.trackedSessions());
   }

   @Test
   @DisplayName("a reconnect takes over: the stale socket closing releases nothing")
   void reconnectKeepsTheWindowAlive() {
      UiSdkClientSessions sessions = new UiSdkClientSessions();
      sessions.bind("browser-1", "session-a");

      // Same tab, new socket — clientId lives in sessionStorage, so it is reused.
      sessions.bind("browser-1", "session-b");
      assertEquals(1, sessions.trackedSessions(), "the replaced socket must not linger");

      assertNull(sessions.onSessionClosed("session-a"), "an open dialogue can still be answered on session-b");
      assertEquals("browser-1", sessions.clientIdOf("session-b"));

      assertEquals("browser-1", sessions.onSessionClosed("session-b"));
      assertEquals(0, sessions.trackedSessions());
   }

   @Test
   @DisplayName("two windows are tracked independently")
   void multipleWindows() {
      UiSdkClientSessions sessions = new UiSdkClientSessions();
      sessions.bind("browser-1", "session-a");
      sessions.bind("browser-2", "session-b");

      assertEquals("browser-1", sessions.onSessionClosed("session-a"));
      assertEquals("browser-2", sessions.clientIdOf("session-b"));
   }

   @Test
   @DisplayName("sockets the SDK never saw (the host's own WebSocket traffic) are ignored")
   void unknownAndBlankInput() {
      UiSdkClientSessions sessions = new UiSdkClientSessions();

      assertNull(sessions.onSessionClosed("session-unknown"));
      assertNull(sessions.onSessionClosed(null));
      assertNull(sessions.onSessionClosed("   "));

      sessions.bind(null, null);
      sessions.bind("", "session-a");
      sessions.bind("browser-1", "  ");
      assertEquals(0, sessions.trackedSessions());
      assertNull(sessions.clientIdOf("nope"));
   }
}
