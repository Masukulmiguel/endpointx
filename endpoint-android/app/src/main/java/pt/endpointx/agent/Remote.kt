package pt.endpointx.agent

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Persistent outbound WebSocket to the EndpointX relay (/remote).
 *
 * The socket is always agent-initiated, so the phone never needs an inbound
 * port and the console can reach it whenever an administrator asks for help.
 */
object Remote {

    private const val TAG = "EndpointXRemote"

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

    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .connectTimeout(20, TimeUnit.SECONDS)
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
    fun connect(ctx: android.content.Context) {
        if (ws != null) return
        val agentId = Prefs.agentId(ctx)
        val token = Prefs.remoteToken(ctx)
        if (agentId.isEmpty() || token.isEmpty()) {
            Log.w(TAG, "not registered yet - skipping connect")
            return
        }

        val request = Request.Builder().url(remoteUrl(Prefs.server(ctx))).build()
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
                        callback?.onConnectionChange(true)
                    }
                    "error" -> Log.w(TAG, "relay refused: ${msg.optString("message")}")
                    "start", "stop", "mouse", "wheel", "key", "type" -> callback?.onCommand(msg)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "socket failed: ${t.message}")
                handleDown()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleDown()
            }
        })
    }

    private fun handleDown() {
        val wasConnected = connected
        connected = false
        ws = null
        if (wasConnected) callback?.onConnectionChange(false)
    }

    @Synchronized
    fun disconnect() {
        connected = false
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
