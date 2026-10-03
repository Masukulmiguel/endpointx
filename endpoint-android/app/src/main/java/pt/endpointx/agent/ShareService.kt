package pt.endpointx.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * Holds the screen-capture consent granted by the phone user and turns the
 * screen into JPEG frames for the console. Frames are only produced while an
 * operator is actually watching.
 */
class ShareService : Service() {

    companion object {
        const val ACTION_START = "pt.endpointx.agent.START_CAPTURE"
        const val ACTION_STOP = "pt.endpointx.agent.STOP_CAPTURE"
        const val ACTION_STREAM = "pt.endpointx.agent.STREAM"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        const val EXTRA_STREAMING = "streaming"
        const val EXTRA_FPS = "fps"
        const val EXTRA_QUALITY = "quality"
        const val EXTRA_MAX_WIDTH = "max_width"

        @Volatile
        var instance: ShareService? = null
            private set

        val isActive: Boolean
            get() = instance?.projecting == true
    }

    @Volatile
    var projecting = false
        private set

    @Volatile
    private var streaming = false

    @Volatile
    private var fps = 8

    @Volatile
    private var quality = 65

    @Volatile
    private var maxWidth = 1600

    @Volatile
    private var nextFrameAt = 0L

    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "projection revoked by system/user")
            stopCapture()
            stopSelf()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        thread = HandlerThread("endpointx-capture").also { it.start() }
        handler = Handler(thread!!.looper)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startProjection(intent)
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_STREAM -> {
                streaming = intent.getBooleanExtra(EXTRA_STREAMING, true)
                fps = intent.getIntExtra(EXTRA_FPS, fps).coerceIn(1, 30)
                quality = intent.getIntExtra(EXTRA_QUALITY, quality).coerceIn(20, 92)
                maxWidth = intent.getIntExtra(EXTRA_MAX_WIDTH, maxWidth).coerceIn(320, 3840)
                if (streaming) nextFrameAt = 0L
            }
        }
        return START_STICKY
    }

    private fun startProjection(intent: Intent) {
        startForegroundNecessary()

        if (projecting) {
            Log.i(TAG, "capture already active")
            return
        }

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val resultData: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        if (resultData == null) {
            Log.w(TAG, "missing projection consent")
            stopSelf()
            return
        }

        try {
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val mediaProjection = manager.getMediaProjection(resultCode, resultData)
                ?: throw IllegalStateException("no projection")
            mediaProjection.registerCallback(projectionCallback, handler)
            projection = mediaProjection
            startVirtualDisplay(mediaProjection)
            projecting = true
            Log.i(TAG, "screen sharing ready")
            Remote.sendCaps(force = true)
        } catch (e: Exception) {
            Log.e(TAG, "could not start projection: ${e.message}")
            Remote.sendError("Autorize o ecrã na app do EndpointX e tente novamente")
            stopSelf()
        }
    }

    private fun startVirtualDisplay(mediaProjection: MediaProjection) {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)

        val width = metrics.widthPixels
        val height = metrics.heightPixels

        val imageReader = ImageReader.newInstance(width, height, android.graphics.PixelFormat.RGBA_8888, 3)
        imageReader.setOnImageAvailableListener({ r -> onFrame(r) }, handler)
        reader = imageReader

        display = mediaProjection.createVirtualDisplay(
            "endpointx",
            width,
            height,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.surface,
            null,
            null
        )
    }

    private fun onFrame(imageReader: ImageReader) {
        val image = imageReader.acquireLatestImage() ?: return
        try {
            if (!streaming) return
            val now = System.currentTimeMillis()
            if (now < nextFrameAt) return
            nextFrameAt = now + (1000L / fps)

            val plane = image.planes[0]
            val buffer: ByteBuffer = plane.buffer
            buffer.rewind()
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val fullWidth = image.width + rowPadding / pixelStride

            val source = Bitmap.createBitmap(fullWidth, image.height, Bitmap.Config.ARGB_8888)
            source.copyPixelsFromBuffer(buffer)
            val frame = if (fullWidth == image.width) source
            else Bitmap.createBitmap(source, 0, 0, image.width, image.height)

            val scale = minOf(1f, maxWidth.toFloat() / frame.width)
            val output = if (scale < 1f) {
                Bitmap.createScaledBitmap(
                    frame,
                    maxOf(1, (frame.width * scale).toInt()),
                    maxOf(1, (frame.height * scale).toInt()),
                    true
                )
            } else frame

            ByteArrayOutputStream().use { out ->
                output.compress(Bitmap.CompressFormat.JPEG, quality, out)
                Remote.sendFrame(out.toByteArray())
            }

            if (output !== frame) output.recycle()
            if (frame !== source) frame.recycle()
            source.recycle()
        } catch (e: Exception) {
            Log.w(TAG, "frame failed: ${e.message}")
        } finally {
            image.close()
        }
    }

    private fun startForegroundNecessary() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel("capture", "Partilha de ecrã", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification = Notification.Builder(this, "capture")
            .setContentTitle("EndpointX - ecrã partilhado")
            .setContentText("A consola pode ver este ecrã enquanto a partilha estiver ativa.")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(84, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(84, notification)
        }
    }

    private fun stopCapture() {
        streaming = false
        projecting = false
        try {
            display?.release()
        } catch (e: Exception) {
            // ignore
        }
        display = null
        try {
            reader?.close()
        } catch (e: Exception) {
            // ignore
        }
        reader = null
        try {
            projection?.stop()
        } catch (e: Exception) {
            // ignore
        }
        projection = null
        Remote.sendStopped()
        Remote.sendCaps(force = true)
    }

    override fun onDestroy() {
        stopCapture()
        instance = null
        thread?.quitSafely()
        thread = null
        handler = null
        super.onDestroy()
    }

    fun applyStream(msg: JSONObject) {
        val intent = Intent(this, ShareService::class.java).setAction(ACTION_STREAM)
            .putExtra(EXTRA_STREAMING, true)
            .putExtra(EXTRA_FPS, msg.optInt("fps", fps))
            .putExtra(EXTRA_QUALITY, msg.optInt("quality", quality))
            .putExtra(EXTRA_MAX_WIDTH, msg.optInt("max_width", maxWidth))
        startService(intent)
    }

    fun stopStream() {
        val intent = Intent(this, ShareService::class.java).setAction(ACTION_STREAM)
            .putExtra(EXTRA_STREAMING, false)
        startService(intent)
    }
}

private const val TAG = "EndpointXShare"
