package cn.toside.music.mobile.diagnostics;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.os.Build;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;

import androidx.localbroadcastmanager.content.LocalBroadcastManager;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Native, JS-independent diagnostics trail for the background-playback freeze/silence bug.
 *
 * Design rules (do not break them):
 * <ul>
 *   <li>every public method is wrapped in try/catch and never throws into the app;</li>
 *   <li>log() never blocks the caller: lines are queued (bounded, 500) and written by the
 *       single "diag-log" HandlerThread;</li>
 *   <li>no Android API above minSdk 21 is used without a Build.VERSION guard;</li>
 *   <li>Java 8 language level only (no var/records/switch expressions).</li>
 * </ul>
 */
public final class DiagnosticsLog {

  private DiagnosticsLog() {}

  /* ------------------------------------------------------------------ */
  /* constants                                                          */
  /* ------------------------------------------------------------------ */

  private static final String LOG_FILE_NAME = "diagnostics-native.log";
  private static final String LOG_FILE_NAME_ROTATED = "diagnostics-native.log.1";
  private static final String WRITER_THREAD_NAME = "diag-log";

  private static final long MAX_LOG_BYTES = 512L * 1024L;
  private static final int MAX_PENDING_LINES = 500;
  private static final int MAX_READ_CHARS = 300000;
  private static final int MAX_MESSAGE_CHARS = 200;
  private static final long ROTATE_RETRY_MS = 30000L;

  private static final long HEARTBEAT_INTERVAL_MS = 15000L;
  private static final long HEARTBEAT_GAP_MS = 40000L;
  private static final long SUMMARY_INTERVAL_MS = 60000L;
  private static final long ACK_UNRESPONSIVE_MS = 20000L;
  private static final long ACK_UNRESPONSIVE_LONG_MS = 60000L;
  private static final long SILENT_PLAYBACK_MS = 8000L;
  private static final long SILENT_PLAYBACK_REPEAT_MS = 30000L;
  private static final long PROBE_ERROR_REPEAT_MS = 60000L;

  private static final long MB = 1024L * 1024L;

  /* thread dump（JS 无响应时抓现场） */
  private static final int MAX_DUMP_LINES = 160;
  private static final int MAX_JS_FRAMES = 48;
  private static final int MAX_MAIN_FRAMES = 32;
  private static final int MAX_OTHER_FRAMES = 3;
  private static final int MAX_FRAME_CHARS = 150;
  /* 缓存目录用量采样（后台线程，主线程只读缓存值） */
  private static final long CACHE_SAMPLE_INTERVAL_MS = 60000L;

  /**
   * TrackPlayer event bus action.
   * Verified against node_modules/react-native-track-player (fork, pinned commit):
   *   service/Utils.java:25  -> public static final String EVENT_INTENT = "com.guichaguri.trackplayer.event";
   * Kept as a local literal on purpose so this file has no compile-time dependency on the fork.
   */
  private static final String TP_EVENT_ACTION = "com.guichaguri.trackplayer.event";

  /* event names, verified in com/guichaguri/trackplayer/module/MusicEvents.java:30-37 */
  private static final String TP_EVT_PLAYBACK_STATE = "playback-state";
  private static final String TP_EVT_PLAYBACK_TRACK_CHANGED = "playback-track-changed";
  private static final String TP_EVT_PLAYBACK_QUEUE_ENDED = "playback-queue-ended";
  private static final String TP_EVT_PLAYBACK_METADATA = "playback-metadata-received";
  private static final String TP_EVT_PLAYBACK_ERROR = "playback-error";
  private static final String TP_EVT_BUTTON_DUCK = "remote-duck";

  /* PlaybackStateCompat values - see comment in tpStateName(int) */
  private static final int TP_STATE_NONE = 0;
  private static final int TP_STATE_STOPPED = 1;
  private static final int TP_STATE_PAUSED = 2;
  private static final int TP_STATE_PLAYING = 3;
  private static final int TP_STATE_FAST_FORWARDING = 4;
  private static final int TP_STATE_REWINDING = 5;
  private static final int TP_STATE_BUFFERING = 6;
  private static final int TP_STATE_ERROR = 7;
  private static final int TP_STATE_CONNECTING = 8;
  private static final int TP_STATE_UNKNOWN = -1;

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */

  private static final Object INIT_LOCK = new Object();
  private static final Object PENDING_LOCK = new Object();
  private static final AtomicBoolean MONITORING = new AtomicBoolean(false);

  private static volatile boolean initialized = false;
  private static volatile Context appContext = null;
  private static volatile File logFile = null;
  private static volatile Handler writer = null;

  private static final ArrayDeque<Line> pendingLines = new ArrayDeque<Line>();
  private static volatile boolean drainScheduled = false;
  private static volatile long droppedLines = 0L;
  /** writer-thread only, never touched from another thread */
  private static SimpleDateFormat writerFormat = null;

  private static volatile long startUptimeMs = 0L;

  /* JS liveness */
  private static volatile long lastJsAckUptimeMs = 0L;
  private static volatile boolean jsAckEver = false;
  private static volatile boolean jsUnresponsive = false;
  private static volatile long jsUnresponsiveSinceMs = 0L;
  private static volatile boolean jsUnresponsiveLongLogged = false;
  private static volatile long lastNoAckLogMs = 0L;
  private static volatile long lastUnresponsiveLogMs = 0L;

  /* main-looper liveness */
  private static volatile long lastTickUptimeMs = 0L;
  private static volatile long lastSummaryUptimeMs = 0L;
  private static volatile Handler mainHandler = null;

  /* memory pressure */
  private static volatile int lastTrimLevel = -1;

  /* activities */
  private static volatile int startedActivities = 0;
  private static volatile int resumedActivities = 0;
  private static volatile int createdActivities = 0;
  private static volatile String activityState = "none";

  /* audio */
  private static volatile boolean audioActiveCache = false;
  private static volatile boolean musicActiveCache = false;
  private static volatile long lastAudioActiveUptimeMs = 0L;
  private static volatile long audioProbeErrors = 0L;
  private static volatile long lastAudioProbeErrorLogMs = 0L;
  /* reflection state for the hidden AudioPlaybackConfiguration.isActive() */
  private static volatile boolean reflectionResolved = false;
  private static volatile boolean reflectionAvailable = true;
  private static volatile java.lang.reflect.Method isActiveMethod = null;

  /* track player */
  private static volatile int lastTpState = TP_STATE_UNKNOWN;
  private static volatile long lastTpStateAtMs = 0L;
  private static volatile long tpSilentForMs = 0L;
  private static volatile long lastSilentLogMs = 0L;
  private static volatile long tpEventCount = 0L;

  /* rotation */
  private static volatile long lastRotateAttemptMs = 0L;

  /* 缓存目录用量（由后台线程更新，主线程只读缓存值，避免在心跳里遍历上千个分片文件） */
  private static volatile long cacheDirMB = -1L;
  private static volatile Thread cacheSamplerThread = null;

  /* registered callbacks / receiver (strong refs so nothing is collected) */
  private static volatile Object componentCallbacksRef = null;
  private static volatile Object activityCallbacksRef = null;
  private static volatile Object audioCallbackRef = null;
  private static volatile Object tpReceiverRef = null;

  /* ------------------------------------------------------------------ */
  /* public API                                                         */
  /* ------------------------------------------------------------------ */

  /** Idempotent. Stores the Application, starts the writer thread and logs the PROCESS start line. */
  public static void init(Context ctx, Application app) {
    try {
      if (initialized) return;
      synchronized (INIT_LOCK) {
        if (initialized) return;
        Context context = app != null ? (Context) app : ctx;
        if (context == null) return;

        appContext = context.getApplicationContext() != null
          ? context.getApplicationContext() : context;

        startUptimeMs = SystemClock.elapsedRealtime();
        lastAudioActiveUptimeMs = startUptimeMs;
        lastTickUptimeMs = 0L;
        lastSummaryUptimeMs = startUptimeMs;

        try {
          File dir = appContext.getFilesDir();
          if (dir != null) logFile = new File(dir, LOG_FILE_NAME);
        } catch (Throwable ignored) {
          logFile = null;
        }

        HandlerThread thread = new HandlerThread(WRITER_THREAD_NAME);
        thread.setDaemon(true);
        thread.start();
        Handler handler = new Handler(thread.getLooper());

        // First task on the writer thread: prepare the formatter, then flush anything queued.
        handler.post(new Runnable() {
          @Override
          public void run() {
            try {
              writerFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
            } catch (Throwable ignored) {
              writerFormat = null;
            }
          }
        });

        // publish only after the formatter task is queued, so queued drains keep log order
        writer = handler;
        initialized = true;

        log("PROCESS", "start " + processStartInfo());
      }
    } catch (Throwable ignored) {
      /* diagnostics must never break app startup */
    }
  }

  /** Appends one line. Never throws, never blocks the caller. */
  public static void log(String tag, String message) {
    try {
      Line line = new Line(tag, message, System.currentTimeMillis(), SystemClock.elapsedRealtime());
      Handler handler = writer;
      if (handler == null) {
        // no writer yet: keep a bounded backlog, drop with a counter beyond that
        synchronized (PENDING_LOCK) {
          if (pendingLines.size() < MAX_PENDING_LINES) pendingLines.addLast(line);
          else droppedLines++;
        }
        return;
      }
      boolean schedule = false;
      synchronized (PENDING_LOCK) {
        if (pendingLines.size() < MAX_PENDING_LINES) {
          pendingLines.addLast(line);
          if (!drainScheduled) {
            drainScheduled = true;
            schedule = true;
          }
        } else {
          droppedLines++;
        }
      }
      if (schedule) {
        if (!handler.post(DRAIN)) {
          synchronized (PENDING_LOCK) {
            drainScheduled = false;
          }
        }
      }
    } catch (Throwable ignored) {
      try {
        droppedLines++;
      } catch (Throwable ignored2) {
        /* nothing left to do */
      }
    }
  }

  /**
   * Returns the rotated file (if any) followed by the current file, capped to the last
   * {@link #MAX_READ_CHARS} characters. Never throws (returns "" on failure).
   * Called from a @ReactMethod (native modules queue thread), so a direct read is fine.
   */
  public static String readLog() {
    try {
      File file = logFile;
      if (file == null) return "";
      File parent = file.getParentFile();
      if (parent == null) return "";

      StringBuilder sb = new StringBuilder();
      appendFile(sb, new File(parent, LOG_FILE_NAME_ROTATED));
      appendFile(sb, file);

      String text = sb.toString();
      if (text.length() > MAX_READ_CHARS) {
        return "[native log truncated]\n" + text.substring(text.length() - MAX_READ_CHARS);
      }
      return text;
    } catch (Throwable ignored) {
      return "";
    }
  }

  /** Called from JS to prove the JS thread is alive. */
  public static void onJsAck() {
    try {
      long now = SystemClock.elapsedRealtime();
      long previous = lastJsAckUptimeMs;
      boolean wasUnresponsive = jsUnresponsive;

      lastJsAckUptimeMs = now;
      jsAckEver = true;
      jsUnresponsive = false;
      jsUnresponsiveSinceMs = 0L;
      jsUnresponsiveLongLogged = false;

      if (wasUnresponsive) {
        long age = previous > 0 ? now - previous : 0L;
        // 能走到这里 => JS 线程还活着（只是刚才被阻塞了），
        // 与"jsFound=0 / 进程被杀"是完全不同的结论，这里显式写明便于检索。
        log("JS_ACK", "resumed after " + age + "ms (JS thread was blocked, not killed)");
      }
    } catch (Throwable ignored) {
      /* never propagate */
    }
  }

  /** One single compact status line, for a @ReactMethod. */
  public static String getStatusString() {
    try {
      long now = SystemClock.elapsedRealtime();
      long ackAge = ackAgeMs(now);
      boolean unresponsive = ackAge > ACK_UNRESPONSIVE_MS;
      long unresponsiveFor = unresponsive && jsUnresponsiveSinceMs > 0
        ? Math.max(0L, now - jsUnresponsiveSinceMs) : 0L;

      boolean audio = audioActive();
      long silentFor = lastTpState == TP_STATE_PLAYING && !audio
        ? Math.max(0L, now - lastAudioActiveUptimeMs) : 0L;

      return "uptimeMs=" + now
        + " ackAgeMs=" + ackAge
        + " jsState=" + (unresponsive ? "unresponsive" : "ok")
        + " jsUnresponsiveMs=" + unresponsiveFor
        + " jsAckEver=" + (jsAckEver ? 1 : 0)
        + " activity=" + activityState
        + " activities=" + startedActivities
        + " processImportance=" + processImportance()
        + " audioActive=" + (audio ? 1 : 0)
        + " musicActive=" + (musicActiveCache ? 1 : 0)
        + " audioActiveReflect=" + (reflectionAvailable ? 1 : 0)
        + " audioProbeErrors=" + audioProbeErrors
        + " tpState=" + tpStateText()
        + " tpSilentFor=" + silentFor
        + " tpEvents=" + tpEventCount
        + " trimLevel=" + lastTrimLevel
        + " nativeHeapMB=" + nativeHeapMB()
        + " javaHeapMB=" + javaHeapMB()
        + " maxHeapMB=" + maxHeapMB()
        + " cacheDirMB=" + cacheDirMB
        + " procUptimeMs=" + procUptimeMs()
        + " uptimeMs=" + now
        + " logBytes=" + logBytes()
        + " droppedLines=" + droppedLines;
    } catch (Throwable ignored) {
      return "status unavailable";
    }
  }

  /** Registers lifecycle / trim / audio / track-player watchers and starts the native heartbeat. */
  public static void startMonitoring(Application app) {
    try {
      if (app == null) return;
      init(app, app);
      if (!MONITORING.compareAndSet(false, true)) return;

      if (mainHandler == null) mainHandler = new Handler(Looper.getMainLooper());

      registerComponentCallbacks(app);
      registerActivityCallbacks(app);
      registerAudioCallback(app);
      registerTrackPlayerReceiver(app);
      startCacheSampler();

      Handler handler = mainHandler;
      if (handler != null) {
        lastTickUptimeMs = 0L;
        handler.postDelayed(HEARTBEAT, HEARTBEAT_INTERVAL_MS);
      }

      log("PROCESS", "monitoring started");
    } catch (Throwable t) {
      try {
        log("PROCESS", "startMonitoring failed " + t.getClass().getSimpleName());
      } catch (Throwable ignored) {
        /* never propagate */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* writer thread                                                      */
  /* ------------------------------------------------------------------ */

  private static final Runnable DRAIN = new Runnable() {
    @Override
    public void run() {
      for (;;) {
        Line line;
        synchronized (PENDING_LOCK) {
          line = pendingLines.pollFirst();
          if (line == null) {
            drainScheduled = false;
            return;
          }
        }
        writeLine(line);
      }
    }
  };

  private static void writeLine(Line line) {
    try {
      File file = logFile;
      if (file == null) {
        droppedLines++;
        return;
      }
      rotateIfNeeded(file);
      String text = format(line);
      FileWriter out = null;
      try {
        out = new FileWriter(file, true);
        out.write(text);
        out.flush();
      } finally {
        if (out != null) {
          try {
            out.close();
          } catch (Throwable ignored) {
            /* ignore */
          }
        }
      }
    } catch (Throwable ignored) {
      try {
        droppedLines++;
      } catch (Throwable ignored2) {
        /* ignore */
      }
    }
  }

  private static void rotateIfNeeded(File file) {
    try {
      if (file.length() <= MAX_LOG_BYTES) return;

      long now = SystemClock.elapsedRealtime();
      if (now - lastRotateAttemptMs < ROTATE_RETRY_MS) return;
      lastRotateAttemptMs = now;

      File rotated = new File(file.getParentFile(), LOG_FILE_NAME_ROTATED);
      if (rotated.exists()) {
        try {
          rotated.delete();
        } catch (Throwable ignored) {
          /* rename below may still fail; handled below */
        }
      }
      if (!file.renameTo(rotated)) {
        // last resort: start a fresh file so the trail keeps growing
        FileWriter out = null;
        try {
          out = new FileWriter(file, false);
          out.flush();
        } finally {
          if (out != null) {
            try {
              out.close();
            } catch (Throwable ignored) {
              /* ignore */
            }
          }
        }
      }
    } catch (Throwable ignored) {
      /* rotation is best effort */
    }
  }

  private static String format(Line line) {
    String time;
    try {
      SimpleDateFormat fmt = writerFormat;
      time = fmt != null ? fmt.format(new Date(line.wallMs)) : String.valueOf(line.wallMs);
    } catch (Throwable ignored) {
      time = String.valueOf(line.wallMs);
    }
    return time + " " + (line.tag == null ? "?" : line.tag) + " "
      + (line.message == null ? "" : line.message)
      + " uptimeMs=" + line.uptimeMs + "\n";
  }

  private static void appendFile(StringBuilder sb, File file) {
    try {
      if (file == null || !file.exists() || file.length() <= 0L) return;
      BufferedReader reader = null;
      try {
        reader = new BufferedReader(new FileReader(file));
        String line;
        while ((line = reader.readLine()) != null) {
          sb.append(line).append('\n');
        }
      } finally {
        if (reader != null) {
          try {
            reader.close();
          } catch (Throwable ignored) {
            /* ignore */
          }
        }
      }
    } catch (Throwable ignored) {
      /* ignore broken halves */
    }
  }

  /* ------------------------------------------------------------------ */
  /* heartbeat                                                          */
  /* ------------------------------------------------------------------ */

  private static final Runnable HEARTBEAT = new Runnable() {
    @Override
    public void run() {
      try {
        tick();
      } catch (Throwable ignored) {
        /* never let the heartbeat die */
      }
      try {
        Handler handler = mainHandler;
        if (handler != null) handler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
      } catch (Throwable ignored) {
        /* ignore */
      }
    }
  };

  private static void tick() {
    long now = SystemClock.elapsedRealtime();

    // 1. did the main looper stop running (= whole process frozen / long block)?
    long previousTick = lastTickUptimeMs;
    if (previousTick > 0L && now - previousTick > HEARTBEAT_GAP_MS) {
      log("NATIVE_GAP", "heartbeat gap " + (now - previousTick) + "ms (process frozen/long block)");
    }
    lastTickUptimeMs = now;

    // 2. is our audio path actually producing media audio?
    boolean audioActive = audioActive();
    if (audioActive) lastAudioActiveUptimeMs = now;

    // 3. THE KEY CHECK: state says PLAYING, but nothing is playing
    tpSilentForMs = 0L;
    if (lastTpState == TP_STATE_PLAYING) {
      long silentFor = now - lastAudioActiveUptimeMs;
      if (!audioActive) {
        tpSilentForMs = silentFor;
        if (silentFor > SILENT_PLAYBACK_MS && now - lastSilentLogMs >= SILENT_PLAYBACK_REPEAT_MS) {
          lastSilentLogMs = now;
          String extra = " musicActive=" + (musicActiveCache ? 1 : 0)
            + (audioProbeErrors > 0 ? " audioProbeErrors=" + audioProbeErrors : "");
          log("SILENT_PLAYBACK", "state=PLAYING but no active audio playback for " + silentFor
            + "ms tpStateAgeMs=" + (lastTpStateAtMs > 0 ? now - lastTpStateAtMs : 0) + extra);
        }
      }
    }

    // 4. JS liveness
    if (!jsAckEver) {
      if (now - lastNoAckLogMs >= ACK_UNRESPONSIVE_LONG_MS) {
        lastNoAckLogMs = now;
        log("JS_ACK", "none yet");
      }
    } else {
      long ackAge = ackAgeMs(now);
      if (ackAge > ACK_UNRESPONSIVE_MS) {
        if (!jsUnresponsive) {
          jsUnresponsive = true;
          jsUnresponsiveSinceMs = lastJsAckUptimeMs > 0L ? lastJsAckUptimeMs : startUptimeMs;
          lastUnresponsiveLogMs = now;
          log("JS_UNRESPONSIVE", "no JS ack for " + ackAge + "ms (JS thread dead or frozen)"
            + " lastAckAtUptimeMs=" + lastJsAckUptimeMs
            + " procUptimeMs=" + procUptimeMs());
          // 立刻抓一次线程现场：这是区分"JS 被阻塞"还是"JS 已消失"的唯一证据
          dumpThreads("first-detected ackAge=" + ackAge + "ms");
        } else if (!jsUnresponsiveLongLogged && ackAge > ACK_UNRESPONSIVE_LONG_MS) {
          jsUnresponsiveLongLogged = true;
          lastUnresponsiveLogMs = now;
          log("JS_UNRESPONSIVE", "no JS ack for " + ackAge + "ms (JS thread dead or frozen)");
          // 30s 后再抓一次：两次栈相同 => 稳定阻塞/死锁；第二次 jsFound=0 => 先卡后死
          dumpThreads("long-threshold ackAge=" + ackAge + "ms");
        } else if (jsUnresponsiveLongLogged && now - lastUnresponsiveLogMs >= ACK_UNRESPONSIVE_LONG_MS) {
          lastUnresponsiveLogMs = now;
          log("JS_UNRESPONSIVE", "no JS ack for " + ackAge + "ms (JS thread dead or frozen)");
        }
      }
    }

    // 5. one compact summary per minute, never more often
    if (now - lastSummaryUptimeMs >= SUMMARY_INTERVAL_MS) {
      lastSummaryUptimeMs = now;
      log("HEARTBEAT", "uptimeMs=" + now
        + " ackAgeMs=" + ackAgeMs(now)
        + " jsAckEver=" + (jsAckEver ? 1 : 0)
        + " audioActive=" + (audioActive ? 1 : 0)
        + " musicActive=" + (musicActiveCache ? 1 : 0)
        + " tpState=" + tpStateText()
        + " activity=" + activityState
        + " activities=" + startedActivities
        + " processImportance=" + processImportance()
        + " nativeHeapMB=" + nativeHeapMB()
        + " javaHeapMB=" + javaHeapMB()
        + " maxHeapMB=" + maxHeapMB()
        + " cacheDirMB=" + cacheDirMB
        + " procUptimeMs=" + procUptimeMs()
        + " trimLevel=" + lastTrimLevel
        + " logBytes=" + logBytes()
        + " droppedLines=" + droppedLines);
    }
  }

  /* ------------------------------------------------------------------ */
  /* thread dump (the decisive evidence for "why did JS stop responding")*/
  /* ------------------------------------------------------------------ */

  /**
   * 把**当前所有线程的栈**写进原生日志。
   *
   * 为什么需要它：已有的 {@code JS_UNRESPONSIVE} 只能证明"JS 不再应答"，却无法区分
   * 两种修法完全不同的原因：
   * <ul>
   *   <li><b>A. 还活着但被卡死</b> —— 同步 native 调用不返回、超长 GC、锁等待。
   *       栈里能直接看到 JS 线程停在哪个 native 帧上；</li>
   *   <li><b>B. 线程已经不存在</b> —— 被系统或 JS 引擎干掉。
   *       此时 {@link Thread#getAllStackTraces()} 里根本没有它（{@code jsFound=0}）。</li>
   * </ul>
   * 二者必须在无响应发生的那一刻取现场，事后无法重建。
   *
   * 实现约束：只在"首次检测到无响应"和"越过 60s 长阈值"时各抓一次；每帧裁剪长度、
   * 总行数设上限；全程吞异常，绝不把异常抛给调用方（心跳不能因此挂掉）。
   */
  private static void dumpThreads(String reason) {
    try {
      Map<Thread, StackTraceElement[]> snapshot = Thread.getAllStackTraces();
      if (snapshot == null) {
        log("THREADS", "dump reason=" + reason + " skipped: no snapshot");
        return;
      }

      Looper mainLooper = Looper.getMainLooper();
      Thread mainThread = mainLooper == null ? null : mainLooper.getThread();
      Thread jsThread = null;
      for (Thread thread : snapshot.keySet()) {
        if (thread == null || thread == mainThread) continue;
        if (isJsThreadName(thread.getName())) {
          jsThread = thread;
          break;
        }
      }

      int remaining = MAX_DUMP_LINES;
      log("THREADS", "dump reason=" + reason
        + " threads=" + snapshot.size()
        + " jsFound=" + (jsThread != null ? 1 : 0)
        + " procUptimeMs=" + procUptimeMs()
        + " javaHeapMB=" + javaHeapMB()
        + " maxHeapMB=" + maxHeapMB());
      remaining--;

      if (jsThread != null) {
        remaining -= dumpOneThread(jsThread, snapshot.get(jsThread), "js", MAX_JS_FRAMES, remaining);
      } else if (remaining > 0) {
        // 这一条本身就是结论：线程不在了，属于"被杀死"而不是"被阻塞"
        log("THREADS", "  @@ js thread NOT FOUND (terminated, not merely blocked)");
        remaining--;
      }

      if (mainThread != null && remaining > 0) {
        StackTraceElement[] frames = snapshot.get(mainThread);
        if (frames == null) frames = mainThread.getStackTrace();
        remaining -= dumpOneThread(mainThread, frames, "main", MAX_MAIN_FRAMES, remaining);
      }

      int others = 0;
      for (Thread thread : snapshot.keySet()) {
        if (thread == null || thread == jsThread || thread == mainThread) continue;
        if (remaining <= 0) break;
        others++;
        remaining--;
        log("THREADS", "  [" + thread.getState() + "] " + clipTo(thread.getName(), 40)
          + " | " + topFrames(snapshot.get(thread), MAX_OTHER_FRAMES));
      }
      log("THREADS", "dump end others=" + others + (remaining <= 0 ? " (truncated)" : ""));
    } catch (Throwable t) {
      try {
        log("THREADS", "dump failed " + t.getClass().getSimpleName());
      } catch (Throwable ignored) {
        /* never propagate */
      }
    }
  }

  /** 写一个线程的完整栈（受预算限制）。返回实际占用的行数。 */
  private static int dumpOneThread(Thread thread, StackTraceElement[] frames, String label,
                                   int maxFrames, int budget) {
    int used = 0;
    try {
      if (budget <= 0) return 0;
      log("THREADS", "  @@ " + label + " name=" + clipTo(thread.getName(), 40)
        + " state=" + thread.getState()
        + " frames=" + (frames == null ? 0 : frames.length));
      used++;
      if (frames == null) return used;
      int limit = Math.min(frames.length, maxFrames);
      for (int i = 0; i < limit && used < budget; i++) {
        log("THREADS", "    #" + i + " " + clipTo(String.valueOf(frames[i]), MAX_FRAME_CHARS));
        used++;
      }
      if (frames.length > limit && used < budget) {
        log("THREADS", "    ... " + (frames.length - limit) + " more frames");
        used++;
      }
    } catch (Throwable ignored) {
      /* ignore */
    }
    return used;
  }

  private static String topFrames(StackTraceElement[] frames, int max) {
    if (frames == null || frames.length == 0) return "-";
    StringBuilder sb = new StringBuilder();
    int limit = Math.min(frames.length, max);
    for (int i = 0; i < limit; i++) {
      if (i > 0) sb.append(" | ");
      sb.append(clipTo(String.valueOf(frames[i]), 80));
    }
    return sb.toString();
  }

  /**
   * 识别 JS 线程。RN 的 JS 线程名形如 {@code mqt_js}（MessageQueueThread "js"），
   * 部分版本/桥接实现用 {@code ReactNativeJS}、{@code mqt_v_js}（bridgeless）或 {@code hermes}。
   */
  private static boolean isJsThreadName(String name) {
    if (name == null) return false;
    String n = name.toLowerCase(Locale.US);
    if (n.contains("reactnativejs")) return true;
    if (n.startsWith("mqt_") && n.contains("js")) return true;
    return n.equals("js") || n.contains("hermes");
  }

  private static String clipTo(String value, int max) {
    if (value == null) return "";
    if (max <= 0 || value.length() <= max) return value;
    return value.substring(0, max) + "...";
  }

  /** 本进程已存活时长（毫秒）。注意与 {@code uptimeMs}（设备开机时长）区分。 */
  private static long procUptimeMs() {
    try {
      if (startUptimeMs <= 0L) return 0L;
      return Math.max(0L, SystemClock.elapsedRealtime() - startUptimeMs);
    } catch (Throwable ignored) {
      return -1L;
    }
  }

  /** Java 堆上限（MB）。用于判断是否处于 largeHeap=off + 小堆的设备上。 */
  private static long maxHeapMB() {
    try {
      return Runtime.getRuntime().maxMemory() / MB;
    } catch (Throwable ignored) {
      return -1L;
    }
  }

  /* ------------------------------------------------------------------ */
  /* audio sampling                                                     */
  /* ------------------------------------------------------------------ */

  private static boolean audioActive() {
    boolean result = false;
    boolean music = false;
    try {
      Context context = appContext;
      if (context == null) return false;
      AudioManager manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
      if (manager == null) return false;

      // cross-check: works on every API level and stays meaningful if the API 26+ probe
      // above is empty because the OEM denied it
      try {
        music = manager.isMusicActive();
      } catch (Throwable ignored) {
        music = false;
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
          result = countActiveMedia(manager.getActivePlaybackConfigurations()) > 0;
        } catch (Throwable t) {
          // some OEM builds require MODIFY_AUDIO_ROUTING here: fall back instead of failing
          probeError(t);
          result = music;
        }
      } else {
        result = music;
      }
    } catch (Throwable t) {
      probeError(t);
      result = false;
    }
    musicActiveCache = music;
    audioActiveCache = result;
    return result;
  }

  /** API 26+ only - called from guarded paths. */
  private static int countActiveMedia(List<AudioPlaybackConfiguration> configs) {
    int count = 0;
    try {
      if (configs == null) return 0;
      for (int i = 0; i < configs.size(); i++) {
        try {
          AudioPlaybackConfiguration config = configs.get(i);
          if (config == null || !configIsActive(config)) continue;
          AudioAttributes attributes = config.getAudioAttributes();
          if (attributes != null && attributes.getUsage() == AudioAttributes.USAGE_MEDIA) count++;
        } catch (Throwable ignored) {
          /* skip broken entry */
        }
      }
    } catch (Throwable ignored) {
      /* ignore */
    }
    return count;
  }

  /**
   * AudioPlaybackConfiguration.isActive() exists at runtime (API 26+) but is hidden from the
   * public SDK stubs (verified: javap on android-36 android.jar lists only getAudioAttributes()
   * and getAudioDeviceInfo()), so it is invoked reflectively. If it is unavailable, entries are
   * assumed active - getActivePlaybackConfigurations() only returns active players anyway.
   */
  private static boolean configIsActive(AudioPlaybackConfiguration config) {
    try {
      if (!reflectionResolved) {
        reflectionResolved = true;
        try {
          isActiveMethod = AudioPlaybackConfiguration.class.getMethod("isActive");
        } catch (Throwable t) {
          isActiveMethod = null;
          reflectionAvailable = false;
        }
      }
      java.lang.reflect.Method method = isActiveMethod;
      if (method != null) {
        Object value = method.invoke(config);
        if (value instanceof Boolean) return ((Boolean) value).booleanValue();
      }
    } catch (Throwable ignored) {
      /* fall through to the permissive default */
    }
    return true;
  }

  private static void probeError(Throwable t) {
    try {
      audioProbeErrors++;
      long now = SystemClock.elapsedRealtime();
      if (now - lastAudioProbeErrorLogMs >= PROBE_ERROR_REPEAT_MS) {
        lastAudioProbeErrorLogMs = now;
        log("AUDIO_PROBE", "error " + (t == null ? "unknown" : t.getClass().getSimpleName()));
      }
    } catch (Throwable ignored) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle callbacks                                                */
  /* ------------------------------------------------------------------ */

  private static void registerComponentCallbacks(Application app) {
    try {
      if (componentCallbacksRef != null) return;
      ComponentCallbacks2 callbacks = new ComponentCallbacks2() {
        @Override
        public void onTrimMemory(int level) {
          try {
            lastTrimLevel = level;
            log("TRIM", "onTrimMemory level=" + level + trimHint(level));
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onLowMemory() {
          try {
            log("TRIM", "onLowMemory");
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onConfigurationChanged(Configuration newConfig) {
          try {
            log("CONFIG", "onConfigurationChanged");
          } catch (Throwable ignored) {
            /* ignore */
          }
        }
      };
      app.registerComponentCallbacks(callbacks);
      componentCallbacksRef = callbacks;
    } catch (Throwable t) {
      log("TRIM", "registerComponentCallbacks failed " + t.getClass().getSimpleName());
    }
  }

  private static void registerActivityCallbacks(Application app) {
    try {
      if (activityCallbacksRef != null) return;
      Application.ActivityLifecycleCallbacks callbacks = new Application.ActivityLifecycleCallbacks() {
        @Override
        public void onActivityCreated(Activity activity, Bundle savedInstanceState) {
          try {
            createdActivities++;
            log("ACTIVITY", "onCreate " + name(activity) + " started=" + startedActivities
              + " created=" + createdActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onActivityStarted(Activity activity) {
          try {
            startedActivities++;
            activityState = resumedActivities > 0 ? "resumed" : "paused";
            log("ACTIVITY", "onStart " + name(activity) + " started=" + startedActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onActivityResumed(Activity activity) {
          try {
            resumedActivities++;
            activityState = "resumed";
            log("ACTIVITY", "onResume " + name(activity) + " started=" + startedActivities
              + " resumed=" + resumedActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onActivityPaused(Activity activity) {
          try {
            resumedActivities--;
            if (resumedActivities < 0) resumedActivities = 0;
            activityState = resumedActivities > 0 ? "resumed"
              : (startedActivities > 0 ? "paused" : activityState);
            log("ACTIVITY", "onPause " + name(activity) + " started=" + startedActivities
              + " resumed=" + resumedActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onActivityStopped(Activity activity) {
          try {
            startedActivities--;
            if (startedActivities < 0) startedActivities = 0;
            activityState = resumedActivities > 0 ? "resumed"
              : (startedActivities > 0 ? "paused" : "stopped");
            log("ACTIVITY", "onStop " + name(activity) + " started=" + startedActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onActivitySaveInstanceState(Activity activity, Bundle outState) {
          try {
            log("ACTIVITY", "onSaveInstanceState " + name(activity) + " started=" + startedActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }

        @Override
        public void onActivityDestroyed(Activity activity) {
          try {
            createdActivities--;
            if (createdActivities < 0) createdActivities = 0;
            log("ACTIVITY", "onDestroy " + name(activity) + " started=" + startedActivities
              + " created=" + createdActivities);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }
      };
      app.registerActivityLifecycleCallbacks(callbacks);
      activityCallbacksRef = callbacks;
    } catch (Throwable t) {
      log("ACTIVITY", "registerActivityLifecycleCallbacks failed " + t.getClass().getSimpleName());
    }
  }

  private static void registerAudioCallback(Application app) {
    try {
      if (audioCallbackRef != null) return;
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

      final AudioManager manager = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
      if (manager == null) return;

      AudioManager.AudioPlaybackCallback callback = new AudioManager.AudioPlaybackCallback() {
        @Override
        public void onPlaybackConfigChanged(List<AudioPlaybackConfiguration> configs) {
          try {
            int active = countActiveMedia(configs);
            int total = configs == null ? 0 : configs.size();
            if (active > 0) lastAudioActiveUptimeMs = SystemClock.elapsedRealtime();
            log("AUDIO", "playbackConfigChanged activeMedia=" + active + " total=" + total);
          } catch (Throwable ignored) {
            /* ignore */
          }
        }
      };
      manager.registerAudioPlaybackCallback(callback, new Handler(Looper.getMainLooper()));
      audioCallbackRef = callback;
    } catch (Throwable t) {
      log("AUDIO", "registerAudioPlaybackCallback failed " + t.getClass().getSimpleName());
    }
  }

  /* ------------------------------------------------------------------ */
  /* track player events                                                */
  /* ------------------------------------------------------------------ */

  private static void registerTrackPlayerReceiver(Application app) {
    try {
      if (tpReceiverRef != null) return;

      BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          try {
            handleTrackPlayerEvent(intent);
          } catch (Throwable ignored) {
            /* never throw out of a receiver */
          }
        }
      };
      IntentFilter filter = new IntentFilter(TP_EVENT_ACTION);
      LocalBroadcastManager.getInstance(app).registerReceiver(receiver, filter);
      tpReceiverRef = receiver;
    } catch (Throwable t) {
      log("TP", "registerReceiver failed " + t.getClass().getSimpleName());
    }
  }

  private static void handleTrackPlayerEvent(Intent intent) {
    if (intent == null) return;
    String event = null;
    Bundle data = null;
    try {
      event = intent.getStringExtra("event");
    } catch (Throwable ignored) {
      /* ignore */
    }
    try {
      data = intent.getBundleExtra("data");
    } catch (Throwable ignored) {
      /* ignore */
    }
    if (event == null) event = "?";

    tpEventCount++;
    long now = SystemClock.elapsedRealtime();

    if (TP_EVT_PLAYBACK_STATE.equals(event)) {
      int state = getInt(data, "state", TP_STATE_UNKNOWN);
      lastTpState = state;
      lastTpStateAtMs = now;
      if (state == TP_STATE_PLAYING) lastSilentLogMs = 0L;
      log("TP", "playback-state state=" + state + "(" + tpStateName(state) + ")");
    } else if (TP_EVT_PLAYBACK_TRACK_CHANGED.equals(event)) {
      log("TP", "playback-track-changed track=" + getInt(data, "track", -1)
        + " nextTrack=" + getInt(data, "nextTrack", -1)
        + " position=" + getDouble(data, "position", 0d));
    } else if (TP_EVT_PLAYBACK_QUEUE_ENDED.equals(event)) {
      log("TP", "playback-queue-ended track=" + getInt(data, "track", -1)
        + " position=" + getDouble(data, "position", 0d));
    } else if (TP_EVT_PLAYBACK_ERROR.equals(event)) {
      log("TP", "playback-error code=" + clip(getString(data, "code", ""))
        + " message=" + clip(getString(data, "message", "")));
    } else if (TP_EVT_BUTTON_DUCK.equals(event)) {
      log("TP", "remote-duck permanent=" + getBoolean(data, "permanent", false)
        + " paused=" + getBoolean(data, "paused", false)
        + " ducking=" + getBoolean(data, "ducking", false));
    } else if (TP_EVT_PLAYBACK_METADATA.equals(event)) {
      log("TP", "playback-metadata-received source=" + clip(getString(data, "source", ""))
        + " title=" + clip(getString(data, "title", ""))
        + " artist=" + clip(getString(data, "artist", "")));
    } else {
      log("TP", "event=" + clip(event) + " keys=" + bundleKeys(data));
    }
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  private static String processStartInfo() {
    String versionName = "?";
    long versionCode = -1L;
    try {
      Context context = appContext;
      if (context != null) {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        if (info != null) {
          versionName = String.valueOf(info.versionName);
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            versionCode = info.getLongVersionCode();
          } else {
            versionCode = info.versionCode;
          }
        }
      }
    } catch (Throwable ignored) {
      /* keep defaults */
    }

    boolean largeHeap = false;
    try {
      Context context = appContext;
      if (context != null) {
        ApplicationInfo info = context.getApplicationInfo();
        largeHeap = info != null && (info.flags & ApplicationInfo.FLAG_LARGE_HEAP) != 0;
      }
    } catch (Throwable ignored) {
      /* ignore */
    }

    long maxMemoryMB = 0L;
    try {
      maxMemoryMB = Runtime.getRuntime().maxMemory() / MB;
    } catch (Throwable ignored) {
      /* ignore */
    }

    long pid = -1L;
    try {
      pid = android.os.Process.myPid();
    } catch (Throwable ignored) {
      /* ignore */
    }

    return "versionName=" + versionName
      + " versionCode=" + versionCode
      + " sdkInt=" + Build.VERSION.SDK_INT
      + " release=" + Build.VERSION.RELEASE
      + " manufacturer=" + Build.MANUFACTURER
      + " model=" + Build.MODEL
      + " largeHeap=" + largeHeap
      + " maxMemoryMB=" + maxMemoryMB
      + " pid=" + pid;
  }

  private static String trimHint(int level) {
    if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE) return " (RUNNING_MODERATE)";
    if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return " (RUNNING_LOW)";
    if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) return " (RUNNING_CRITICAL)";
    if (level == ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) return " (UI_HIDDEN)";
    if (level == ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) return " (BACKGROUND)";
    if (level == ComponentCallbacks2.TRIM_MEMORY_MODERATE) return " (MODERATE)";
    if (level == ComponentCallbacks2.TRIM_MEMORY_COMPLETE) return " (COMPLETE)";
    return "";
  }

  private static String tpStateName(int state) {
    // Values verified against androidx.media/support PlaybackStateCompat constants
    // (javap on media-1.7.0.aar: NONE=0, STOPPED=1, PAUSED=2, PLAYING=3,
    //  FAST_FORWARDING=4, REWINDING=5, BUFFERING=6, ERROR=7, CONNECTING=8) and against the
    // fork's ExoPlayback.getState() (ExoPlayback.java:246-257).
    switch (state) {
      case TP_STATE_NONE:
        return "NONE";
      case TP_STATE_STOPPED:
        return "STOPPED";
      case TP_STATE_PAUSED:
        return "PAUSED";
      case TP_STATE_PLAYING:
        return "PLAYING";
      case TP_STATE_FAST_FORWARDING:
        return "FAST_FORWARDING";
      case TP_STATE_REWINDING:
        return "REWINDING";
      case TP_STATE_BUFFERING:
        return "BUFFERING";
      case TP_STATE_ERROR:
        return "ERROR";
      case TP_STATE_CONNECTING:
        return "CONNECTING";
      default:
        return state < 0 ? "UNKNOWN" : "?";
    }
  }

  private static String tpStateText() {
    int state = lastTpState;
    if (state == TP_STATE_UNKNOWN) return "none";
    return state + "(" + tpStateName(state) + ")";
  }

  private static long ackAgeMs(long now) {
    try {
      if (jsAckEver && lastJsAckUptimeMs > 0L) return Math.max(0L, now - lastJsAckUptimeMs);
      if (startUptimeMs > 0L) return Math.max(0L, now - startUptimeMs);
      return 0L;
    } catch (Throwable ignored) {
      return 0L;
    }
  }

  private static int processImportance() {
    try {
      ActivityManager manager = appContext == null ? null
        : (ActivityManager) appContext.getSystemService(Context.ACTIVITY_SERVICE);
      if (manager == null) return -1;
      ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
      ActivityManager.getMyMemoryState(info);
      return info.importance;
    } catch (Throwable ignored) {
      return -1;
    }
  }

  private static long nativeHeapMB() {
    try {
      return Debug.getNativeHeapAllocatedSize() / MB;
    } catch (Throwable ignored) {
      return -1L;
    }
  }

  private static long javaHeapMB() {
    try {
      Runtime runtime = Runtime.getRuntime();
      return (runtime.totalMemory() - runtime.freeMemory()) / MB;
    } catch (Throwable ignored) {
      return -1L;
    }
  }

  private static long logBytes() {
    try {
      long bytes = 0L;
      File file = logFile;
      if (file == null) return 0L;
      bytes += file.length();
      File rotated = new File(file.getParentFile(), LOG_FILE_NAME_ROTATED);
      if (rotated.exists()) bytes += rotated.length();
      return bytes;
    } catch (Throwable ignored) {
      return -1L;
    }
  }

  /**
   * 播放缓存的磁盘占用（MB）。
   *
   * 为什么单独采样：用户会怀疑"缓存写满是不是把 JS 搞挂了"。要能回答这个问题，
   * 日志里必须有缓存用量本身；此前完全没有这个指标，只能靠推测。
   *
   * 目录取自 RNTP 的实现（node_modules/react-native-track-player ...
   * service/player/LocalPlayback.java：{@code new File(context.getFilesDir(), "TrackPlayer")}）。
   * 目录里可能有上千个分片文件，因此**在独立后台线程里统计**，心跳只读缓存值，
   * 避免为了诊断反而在主线程上制造卡顿。
   */
  private static void startCacheSampler() {
    try {
      if (cacheSamplerThread != null) return;
      Thread thread = new Thread(new Runnable() {
        @Override
        public void run() {
          while (true) {
            try {
              updateCacheDirSize();
            } catch (Throwable ignored) {
              /* ignore */
            }
            try {
              Thread.sleep(CACHE_SAMPLE_INTERVAL_MS);
            } catch (InterruptedException e) {
              return;
            }
          }
        }
      }, "diag-cache");
      thread.setDaemon(true);
      thread.start();
      cacheSamplerThread = thread;
    } catch (Throwable ignored) {
      /* ignore */
    }
  }

  private static void updateCacheDirSize() {
    try {
      Context ctx = appContext;
      if (ctx == null) return;
      File dir = new File(ctx.getFilesDir(), "TrackPlayer");
      cacheDirMB = dirSize(dir, 0) / MB;
    } catch (Throwable ignored) {
      /* ignore */
    }
  }

  private static long dirSize(File dir, int depth) {
    if (dir == null || depth > 6) return 0L;
    File[] files;
    try {
      files = dir.listFiles();
    } catch (Throwable ignored) {
      return 0L;
    }
    if (files == null) return 0L;
    long total = 0L;
    for (File file : files) {
      if (file == null) continue;
      try {
        if (file.isDirectory()) total += dirSize(file, depth + 1);
        else total += file.length();
      } catch (Throwable ignored) {
        /* skip this entry */
      }
    }
    return total;
  }

  private static String name(Activity activity) {
    try {
      if (activity == null) return "?";
      String simple = activity.getClass().getSimpleName();
      return simple == null || simple.length() == 0 ? "?" : simple;
    } catch (Throwable ignored) {
      return "?";
    }
  }

  private static String clip(String value) {
    if (value == null) return "";
    if (value.length() <= MAX_MESSAGE_CHARS) return value;
    return value.substring(0, MAX_MESSAGE_CHARS) + "...";
  }

  private static String bundleKeys(Bundle bundle) {
    try {
      if (bundle == null) return "none";
      java.util.Set<String> keys = bundle.keySet();
      if (keys == null || keys.isEmpty()) return "none";
      StringBuilder sb = new StringBuilder();
      for (String key : keys) {
        if (sb.length() > 0) sb.append(',');
        sb.append(key);
        if (sb.length() > MAX_MESSAGE_CHARS) {
          sb.append("...");
          break;
        }
      }
      return sb.toString();
    } catch (Throwable ignored) {
      return "?";
    }
  }

  /* defensive Bundle readers: keys may be missing or of an unexpected type */
  private static int getInt(Bundle bundle, String key, int fallback) {
    try {
      if (bundle != null && bundle.containsKey(key)) return bundle.getInt(key, fallback);
    } catch (Throwable ignored) {
      /* ignore */
    }
    return fallback;
  }

  private static double getDouble(Bundle bundle, String key, double fallback) {
    try {
      if (bundle != null && bundle.containsKey(key)) return bundle.getDouble(key, fallback);
    } catch (Throwable ignored) {
      /* ignore */
    }
    return fallback;
  }

  private static boolean getBoolean(Bundle bundle, String key, boolean fallback) {
    try {
      if (bundle != null && bundle.containsKey(key)) return bundle.getBoolean(key, fallback);
    } catch (Throwable ignored) {
      /* ignore */
    }
    return fallback;
  }

  private static String getString(Bundle bundle, String key, String fallback) {
    try {
      if (bundle != null && bundle.containsKey(key)) {
        String value = bundle.getString(key);
        return value == null ? fallback : value;
      }
    } catch (Throwable ignored) {
      /* ignore */
    }
    return fallback;
  }

  /* ------------------------------------------------------------------ */
  /* line holder                                                        */
  /* ------------------------------------------------------------------ */

  private static final class Line {
    final String tag;
    final String message;
    final long wallMs;
    final long uptimeMs;

    Line(String tag, String message, long wallMs, long uptimeMs) {
      this.tag = tag;
      this.message = message;
      this.wallMs = wallMs;
      this.uptimeMs = uptimeMs;
    }
  }
}
