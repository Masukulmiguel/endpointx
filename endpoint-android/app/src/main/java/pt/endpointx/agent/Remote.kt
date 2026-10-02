package pt.endpointx.agent

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Persistent outbound WebSocket to the EndpointX relay (/remote).
 *
 * The socket is always agent-initiated, so the phone never needs an inbound
 * port and the console can reach it whenever an administrator asks for help.
 *
 * Mobile networks drop idle links constantly (and Android kills sockets while
 * the screen is off), so every failure schedules a reconnect with exponential
 * backoff instead of waiting for the service to be restarted by hand.
 */
object Remote {

    private const val TAG = "EndpointXRemote"
    private const val MAX_BACKOFF_MS = 30_000L

    interface Callback {
        /** A control message from the console (start/stop/mouse/key/type/wheel). */
        fun onCommand(message: JSONObject)

        /** Socket became usable (or stopped being usable). */
        fun onConnectionChange(connected: Boolean)
    }

    @Volatile
    var callback: Callback? = null

    @Volatile
    private var ws: WebSocket? = null

    @Volatile
    var connected: Boolean = false
        private set

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var attempt = 0

    @Volatile
    private var reconnectScheduled = false

    @Volatile
    private var pending: ScheduledFuture<*>? = null

    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "endpointx-remote").apply { isDaemon = true }
        }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()

    fun remoteUrl(server: String): String {
        val base = server.trim().trimEnd('/')
        return when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://") + "/remote"
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://") + "/remote"
            else -> "wss://$base/remote"
        }
    }

    @Synchronized
    fun connect(ctx: Context) {
        appContext = ctx.applicationContext
        if (ws != null) return
        val context = appContext ?: return
        val agentId = Prefs.agentId(context)
        val token = Prefs.remoteToken(context)
        if (agentId.isEmpty() || token.isEmpty()) {
            Log.w(TAG, "not registered yet - skipping connect")
            return
        }

        val request = Request.Builder().url(remoteUrl(Prefs.server(context))).build()
        Log.i(TAG, "connecting (try ${attempt + 1})")
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val hello = JSONObject()
                    .put("t", "hello")
                    .put("role", "agent")
                    .put("agent_id", agentId)
                    .put("secret", token)
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    return
                }
                when (msg.optString("t")) {
                    "ready" -> {
                        connected = true
                        attempt = 0
                        callback?.onConnectionChange(true)
                    }
                    "error" -> Log.w(TAG, "relay refused: ${msg.optString("message")}")
                    "start", "stop", "mouse", "wheel", "key", "type" -> callback?.onCommand(msg)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "socket failed: ${t.message}")
                if (webSocket === ws) handleDown()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket === ws) handleDown()
            }
        })
    }

    private fun handleDown() {
        val wasConnected = connected
        connected = false
        ws = null
        if (wasConnected) callback?.onConnectionChange(false)
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        val context = appContext ?: return
        synchronized(this) {
            if (reconnectScheduled) return
            reconnectScheduled = true
            val delay = (1000L shl attempt.coerceAtMost(5)).coerceAtMost(MAX_BACKOFF_MS)
            attempt = (attempt + 1).coerceAtMost(6)
            Log.i(TAG, "reconnecting in ${delay}ms")
            pending = scheduler.schedule({
                synchronized(this) { reconnectScheduled = false }
                try {
                    connect(context)
                } catch (e: Exception) {
                    Log.w(TAG, "reconnect failed: ${e.message}")
                }
            }, delay, TimeUnit.MILLISECONDS)
        }
    }

    @Synchronized
    fun disconnect() {
        connected = false
        attempt = 0
        try {
            pending?.cancel(false)
        } catch (e: Exception) {
            // ignore
        }
        pending = null
        reconnectScheduled = false
        try {
            ws?.close(1000, "bye")
        } catch (e: Exception) {
            // ignore
        }
        ws = null
    }

    fun sendFrame(jpeg: ByteArray): Boolean {
        val socket = ws ?: return false
        return socket.send(ByteString.of(*jpeg))
    }

    fun send(payload: JSONObject): Boolean {
        val socket = ws ?: return false
        return socket.send(payload.toString())
    }

    fun sendError(message: String) {
        send(JSONObject().put("t", "error").put("message", message))
    }

    fun sendStopped() {
        send(JSONObject().put("t", "stopped"))
    }
}
