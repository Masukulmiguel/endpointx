package pt.endpointx.agent

import android.content.Context
import android.content.SharedPreferences

/** Small wrapper around the device's local configuration. */
object Prefs {
    private const val FILE = "endpointx_agent"

    fun get(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private fun SharedPreferences.str(key: String, def: String = ""): String =
        getString(key, def) ?: def

    fun server(ctx: Context): String =
        get(ctx).str("server", "https://endpointx.onrender.com").trim().trimEnd('/')

    fun setServer(ctx: Context, value: String) =
        get(ctx).edit().putString("server", value.trim().trimEnd('/')).apply()

    fun agentId(ctx: Context): String = get(ctx).str("agent_id")

    fun setAgentId(ctx: Context, value: String) =
        get(ctx).edit().putString("agent_id", value).apply()

    fun remoteToken(ctx: Context): String = get(ctx).str("remote_token")

    fun setRemoteToken(ctx: Context, value: String) =
        get(ctx).edit().putString("remote_token", value).apply()

    fun deviceId(ctx: Context): String = get(ctx).str("device_id")

    fun setDeviceId(ctx: Context, value: String) =
        get(ctx).edit().putString("device_id", value).apply()

    fun deviceName(ctx: Context): String = get(ctx).str("device_name")

    fun setDeviceName(ctx: Context, value: String) =
        get(ctx).edit().putString("device_name", value).apply()

    fun enrollToken(ctx: Context): String = get(ctx).str("enroll_token")

    fun setEnrollToken(ctx: Context, value: String) =
        get(ctx).edit().putString("enroll_token", value).apply()

    fun approvalStatus(ctx: Context): String = get(ctx).str("approval_status", "unknown")

    fun setApprovalStatus(ctx: Context, value: String) =
        get(ctx).edit().putString("approval_status", value).apply()

    fun hasSession(ctx: Context): Boolean = agentId(ctx).isNotEmpty() && remoteToken(ctx).isNotEmpty()
}
