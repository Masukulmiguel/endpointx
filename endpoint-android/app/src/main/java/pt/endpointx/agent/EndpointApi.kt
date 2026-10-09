package pt.endpointx.agent

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.StatFs
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** HTTP side of the agent: enrolment and presence heartbeat. */
object EndpointApi {

    data class RegisterResult(
        val agentId: String,
        val deviceId: String,
        val remoteToken: String,
        val approvalStatus: String,
        val isNew: Boolean
    )

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun register(ctx: Context, deviceName: String, enrollToken: String): RegisterResult {
        val body = JSONObject().apply {
            put("device_name", deviceName)
            put("os_type", "android")
            put("device_type", "MOBILE")
            put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            put("user_agent", "EndpointXAgentAndroid/1.3.0 (${Build.MODEL})")
            put("source", "android_app")
            if (enrollToken.isNotEmpty()) put("enroll_token", enrollToken)
            val existing = Prefs.agentId(ctx)
            if (existing.isNotEmpty()) put("agent_id", existing)
        }

        val request = Request.Builder()
            .url("${Prefs.server(ctx)}/api/devices/mobile/register")
            .post(body.toString().toRequestBody(JSON))
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = JSONObject(if (text.isEmpty()) "{}" else text)
            if (!response.isSuccessful || !json.optBoolean("success", false)) {
                val message = json.optJSONObject("error")?.optString("message")
                    ?: if (text.isEmpty()) "HTTP ${response.code}" else text.take(200)
                throw IllegalStateException(message)
            }
            val data = json.optJSONObject("data") ?: JSONObject()
            return RegisterResult(
                agentId = data.optString("agent_id"),
                deviceId = data.optString("device_id"),
                remoteToken = data.optString("remote_token"),
                approvalStatus = data.optString("approval_status", "pending"),
                isNew = data.optBoolean("is_new", false)
            )
        }
    }

    fun heartbeat(ctx: Context): Boolean {
        val agentId = Prefs.agentId(ctx)
        if (agentId.isEmpty()) return false

        val battery = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

        val body = JSONObject().apply {
            put("agent_id", agentId)
            put("battery_level", if (level in 0..100) level else -1)
            put("network", "wifi")
            systemInfo(ctx)?.let { info ->
                for (key in info.keys()) put(key, info.get(key))
            }
        }

        val request = Request.Builder()
            .url("${Prefs.server(ctx)}/api/devices/mobile/heartbeat")
            .post(body.toString().toRequestBody(JSON))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Real hardware numbers for the dashboard: memory is read from
     * ActivityManager (total/available), storage from StatFs and the CPU
     * percentage is sampled from /proc/stat (null when the OS masks it).
     */
    private fun systemInfo(ctx: Context): JSONObject? {
        return try {
            val out = JSONObject()
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mem = ActivityManager.MemoryInfo()
            am.getMemoryInfo(mem)
            val total = mem.totalMem
            val used = (total - mem.availMem).coerceAtLeast(0L)
            if (total > 0) {
                out.put("ram_total", total)
                out.put("ram_used", used)
                out.put("ram_usage", round1(used.toDouble() * 100.0 / total))
            }
            val cores = Runtime.getRuntime().availableProcessors()
            if (cores > 0) out.put("cpu_cores", cores)
            cpuUsagePercent()?.let { out.put("cpu_usage", it) }
            putStorage(out)
            out
        } catch (e: Exception) {
            null
        }
    }

    private fun putStorage(out: JSONObject) {
        try {
            val stat = StatFs(android.os.Environment.getDataDirectory().path)
            val total = stat.totalBytes
            val free = stat.freeBytes
            if (total > 0) {
                val used = (total - free).coerceAtLeast(0L)
                out.put("disk_total", total)
                out.put("disk_used", used)
                out.put("disk_usage", round1(used.toDouble() * 100.0 / total))
            }
        } catch (e: Exception) {
            // ignore - storage is optional
        }
    }

    private fun round1(value: Double): Double = Math.round(value * 10.0) / 10.0

    /** Best-effort system CPU %: two /proc/stat samples 400ms apart. */
    private fun cpuUsagePercent(): Double? {
        val first = cpuSample() ?: return null
        try {
            Thread.sleep(400)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return null
        }
        val second = cpuSample() ?: return null
        val busy = second[0] - first[0]
        val total = second[1] - first[1]
        if (total <= 0) return null
        return round1((busy / total) * 100.0).coerceIn(0.0, 100.0)
    }

    /** Returns [busy, total] jiffies, or null when /proc/stat is unreadable/zeroed. */
    private fun cpuSample(): DoubleArray? {
        return try {
            val line = java.io.File("/proc/stat").readText().lineSequence().firstOrNull { it.startsWith("cpu ") }
                ?: return null
            val p = line.trim().split(Regex("\\s+"))
            if (p.size < 5) return null
            val user = p[1].toLongOrNull() ?: return null
            val nice = p[2].toLongOrNull() ?: return null
            val system = p[3].toLongOrNull() ?: return null
            val idle = p[4].toLongOrNull() ?: return null
            val iowait = p.getOrNull(5)?.toLongOrNull() ?: 0L
            doubleArrayOf((user + nice + system).toDouble(), (user + nice + system + idle + iowait).toDouble())
        } catch (e: Exception) {
            null
        }
    }
}
