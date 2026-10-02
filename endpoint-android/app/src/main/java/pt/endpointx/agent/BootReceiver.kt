package pt.endpointx.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Brings the management channel back after a reboot. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!Prefs.hasSession(context)) return
        RemoteService.start(context)
    }
}
