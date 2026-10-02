package pt.endpointx.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Remote.callback = this
        scheduler = Executors.newSingleThreadScheduledExecutor()
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
            }, 0, 60, TimeUnit.SECONDS)
        }
        return START_STICKY
    }

    override fun onCommand(message: JSONObject) {
        when (message.optString("t")) {
            "start" -> {
                val share = ShareService.instance
                if (share == null || !share.projecting) {
                    Remote.sendError("Autorize a partilha de ecrã na app EndpointX do telemóvel")
                    return
                }
                share.applyStream(message)
            }
            "stop" -> {
                ShareService.instance?.stopStream()
                Remote.sendStopped()
            }
            "mouse", "wheel", "key", "type" -> {
                ControlService.instance?.handle(message)
            }
        }
    }

    override fun onConnectionChange(connected: Boolean) {
        showNotification(
            if (connected) "Pronto - a consola pode pedir assistência"
            else "Sem ligação ao servidor - a tentar novamente"
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
        scheduler?.shutdownNow()
        scheduler = null
        Remote.callback = null
        Remote.disconnect()
        super.onDestroy()
    }
}
