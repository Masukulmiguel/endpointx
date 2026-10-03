package pt.endpointx.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.pm.PackageManager
import android.graphics.Path
import android.os.Bundle
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Injects the operator's input into the phone using the Android accessibility
 * API (the same mechanism every remote-control app uses - tap, swipe, scroll,
 * text and global navigation).
 */
class ControlService : AccessibilityService() {

    companion object {
        private const val TAG = "EndpointXControl"
        private const val WRITE_SECURE = "android.permission.WRITE_SECURE_SETTINGS"

        @Volatile
        var instance: ControlService? = null
            private set

        val isReady: Boolean
            get() = instance != null

        /** True when the app holds WRITE_SECURE_SETTINGS (granted once over adb). */
        fun canSelfEnable(context: android.content.Context): Boolean =
            context.checkCallingOrSelfPermission(WRITE_SECURE) == PackageManager.PERMISSION_GRANTED

        /** True when the system already has this accessibility service switched on. */
        fun isEnabled(context: android.content.Context): Boolean {
            val component = component(context)
            val current = Settings.Secure.getString(
                context.applicationContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ).orEmpty()
            return current.split(':').any { it.equals(component, ignoreCase = true) }
        }

        /**
         * Turns the service on without going through the Settings screen, so the
         * Android 13+ "restricted setting" block (which stops sideloaded apps from
         * being toggled by hand) never comes into play. Returns false when the
         * permission was not granted over adb.
         */
        fun enableSelf(context: android.content.Context): Boolean {
            if (!canSelfEnable(context)) return false
            return try {
                val cr = context.applicationContext.contentResolver
                val current = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
                val parts = current.split(':').filter { it.isNotBlank() }.toMutableList()
                val target = component(context)
                if (parts.none { it.equals(target, ignoreCase = true) }) {
                    parts.add(target)
                    if (!Settings.Secure.putString(
                            cr,
                            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                            parts.joinToString(":")
                        )
                    ) {
                        Log.w(TAG, "could not write enabled_accessibility_services")
                        return false
                    }
                }
                Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
                Log.i(TAG, "accessibility service enabled programmatically")
                true
            } catch (e: Exception) {
                Log.w(TAG, "could not enable service: ${e.message}")
                false
            }
        }

        private fun component(context: android.content.Context): String =
            ComponentName(context, ControlService::class.java).flattenToString()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "control service ready")
        Remote.sendCaps(force = true)
    }

    override fun onInterrupt() {
        // no-op
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {
        // no-op: the service is only used to dispatch gestures
    }

    override fun onDestroy() {
        instance = null
        Remote.sendCaps(force = true)
        super.onDestroy()
    }

    private fun screenSize(): Pair<Float, Float> {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
        return metrics.widthPixels.toFloat() to metrics.heightPixels.toFloat()
    }

    private fun gesture(path: Path, duration: Long) {
        val stroke = GestureDescription.StrokeDescription(path, 0L, duration.coerceIn(50L, 4000L))
        val description = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(description, null, null)
    }

    /** Handles {t:'mouse'|'wheel'|'key'|'type'} messages from the console. */
    fun handle(message: org.json.JSONObject) {
        try {
            when (message.optString("t")) {
                "mouse" -> handleMouse(message)
                "wheel" -> handleWheel(message)
                "key" -> handleKey(message)
                "type" -> {
                    val text = message.optString("text")
                    if (text.isNotEmpty()) setText(text)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "input failed: ${e.message}")
        }
    }

    private var downX = 0f
    private var downY = 0f
    private var downAt = 0L
    private val path = Path()

    private fun handleMouse(message: org.json.JSONObject) {
        val (w, h) = screenSize()
        val x = (message.optDouble("x", 0.0).toFloat() * w).coerceIn(0f, w - 1f)
        val y = (message.optDouble("y", 0.0).toFloat() * h).coerceIn(0f, h - 1f)

        when (message.optString("action", "move")) {
            "click", "dblclick" -> tap(x, y)
            "down" -> {
                downX = x
                downY = y
                downAt = System.currentTimeMillis()
                path.reset()
                path.moveTo(x, y)
            }
            "move" -> {
                if (downAt > 0L) path.lineTo(x, y)
            }
            "up" -> {
                if (downAt == 0L) return
                val distance = Math.hypot((x - downX).toDouble(), (y - downY).toDouble())
                val elapsed = System.currentTimeMillis() - downAt
                downAt = 0L
                if (distance < 12 && elapsed < 500) {
                    tap(x, y)
                } else {
                    path.lineTo(x, y)
                    gesture(path, elapsed.coerceIn(120L, 1500L))
                }
                path.reset()
            }
        }
    }

    private fun tap(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        gesture(path, 80)
    }

    private fun handleWheel(message: org.json.JSONObject) {
        val dy = message.optDouble("dy", 0.0).toFloat()
        if (dy == 0f) return
        val (w, h) = screenSize()
        // dy < 0 means "wheel down" on the console => finger slides up on the phone
        val travel = (dy * 60f).coerceIn(-h * 0.6f, h * 0.6f)
        val startY = (h / 2f) - travel / 2f
        val endY = (h / 2f) + travel / 2f
        val path = Path().apply {
            moveTo(w / 2f, startY)
            lineTo(w / 2f, endY)
        }
        gesture(path, 220)
    }

    private fun handleKey(message: org.json.JSONObject) {
        if (message.optString("action", "down") != "down") return
        when (message.optString("code")) {
            "Escape", "Backspace" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "Home", "MetaLeft", "MetaRight" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "Tab" -> focusedNode()?.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        }
    }

    private fun focusedNode(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focus != null) return focus
        return searchEditable(root)
    }

    private fun searchEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = searchEditable(child)
            if (found != null) return found
        }
        return null
    }

    private fun setText(text: String) {
        val target = focusedNode() ?: return
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }
}
