package pt.endpointx.agent

import android.content.Context
import android.os.BatteryManager
import android.os.Build
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
            put("user_agent", "EndpointXAgentAndroid/1.0 (${Build.MODEL})")
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
}
