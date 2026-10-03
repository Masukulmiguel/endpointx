package pt.endpointx.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Always-on management channel: keeps the WebSocket to the console alive and
 * reports presence, so an administrator can request assistance at any time.
 */
class RemoteService : Service(), Remote.Callback {

    companion object {
        private const val TAG = "EndpointXRemoteSvc"
        private const val CHANNEL = "remote"
        private const val NOTIFICATION_ID = 83

        fun start(context: Context) {
            val intent = Intent(context, RemoteService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
            } catch (e: Exception) {
                Log.w(TAG, "could not start remote service: ${e.message}")
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, RemoteService::class.java))
            } catch (e: Exception) {
                // ignore
            }
        }
    }

    private var scheduler: ScheduledExecutorService? = null
    private var heartbeatScheduled = false
    private var watchdogScheduled = false
    private var connectivity: ConnectivityManager? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Data/Wi-Fi came back: skip the backoff and reconnect at once so
            // the phone is reachable (and shows online) without a long wait.
            try {
                Remote.reconnectNow(applicationContext)
            } catch (e: Exception) {
                Log.d(TAG, "network reconnect failed: ${e.message}")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Remote.callback = this
        scheduler = Executors.newSingleThreadScheduledExecutor()
        connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        try {
            connectivity?.registerNetworkCallback(
                NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                networkCallback
            )
        } catch (e: Exception) {
            Log.w(TAG, "could not register network callback: ${e.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        showNotification("A ligar ao servidor EndpointX...")
        Remote.connect(this)
        if (!heartbeatScheduled) {
            heartbeatScheduled = true
            scheduler?.scheduleAtFixedRate({
                try {
                    EndpointApi.heartbeat(this)
                } catch (e: Exception) {
                    Log.d(TAG, "heartbeat failed: ${e.message}")
                }
            }, 0, 30, TimeUnit.SECONDS)
        }
        if (!watchdogScheduled) {
            watchdogScheduled = true
            // Safety net: if the socket silently died (doze, network switch,
            // server restart) this brings it back without waiting for a reboot,
            // and the accessibility service is switched back on whenever the
            // app holds the ADB-granted permission (a reboot/update can turn it
            // off, which is what makes remote input stop working "sometimes").
            scheduler?.scheduleAtFixedRate({
                try {
                    if (!Remote.connected) Remote.connect(this)
                    if (!ControlService.isEnabled(this)) ControlService.enableSelf(this)
                } catch (e: Exception) {
                    Log.d(TAG, "reconnect watchdog failed: ${e.message}")
                }
            }, 15, 15, TimeUnit.SECONDS)
        }
        return START_STICKY
    }

    override fun onCommand(message: JSONObject) {
        when (message.optString("t")) {
            "start" -> {
                val share = ShareService.instance
                if (share == null || !share.projecting) {
                    // Report the missing permission instead of a hard error:
                    // the console turns this into an actionable banner.
                    Remote.sendCaps()
                    return
                }
                share.applyStream(message)
            }
            "stop" -> {
                ShareService.instance?.stopStream()
                Remote.sendStopped()
            }
            "mouse", "wheel", "key", "type" -> {
                val control = ControlService.instance
                if (control == null) {
                    // Without the accessibility service the input would be
                    // dropped with no feedback - tell the console why.
                    Remote.sendCaps()
                    return
                }
                control.handle(message)
            }
        }
    }

    override fun onConnectionChange(connected: Boolean) {
        showNotification(
            if (connected) "Pronto - a consola pode pedir assistência"
            else "Sem ligação - a reconectar automaticamente"
        )
    }

    private fun showNotification(text: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "EndpointX", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("EndpointX")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()

        try {
            startForeground(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            Log.w(TAG, "startForeground failed: ${e.message}")
        }
    }

    override fun onDestroy() {
        try {
            connectivity?.unregisterNetworkCallback(networkCallback)
        } catch (e: Exception) {
            // ignore: was never registered
        }
        connectivity = null
        scheduler?.shutdownNow()
        scheduler = null
        Remote.callback = null
        Remote.disconnect()
        super.onDestroy()
    }
}
