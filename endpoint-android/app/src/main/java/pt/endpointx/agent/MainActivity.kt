package pt.endpointx.agent

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {

    companion object {
        private const val REQ_CAPTURE = 4401
        private const val REQ_NOTIFICATIONS = 4402
    }

    private lateinit var server: EditText
    private lateinit var deviceName: EditText
    private lateinit var enrollToken: EditText
    private lateinit var status: TextView
    private val io = Executors.newSingleThreadExecutor()
    private val stamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        server = findViewById(R.id.serverUrl)
        deviceName = findViewById(R.id.deviceName)
        enrollToken = findViewById(R.id.enrollToken)
        status = findViewById(R.id.status)

        deviceName.setText(Prefs.deviceName(this))
        enrollToken.setText(Prefs.enrollToken(this))
        server.setText(Prefs.server(this))

        findViewById<Button>(R.id.btnRegister).setOnClickListener { register() }
        findViewById<Button>(R.id.btnShare).setOnClickListener { requestCapture() }
        findViewById<Button>(R.id.btnStopShare).setOnClickListener { stopCapture() }
        findViewById<Button>(R.id.btnAllowRestricted).setOnClickListener { openAppDetails() }
        findViewById<Button>(R.id.btnControl).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            if (!ControlService.isReady) {
                log(
                    "Procure \"EndpointX\" em Apps descarregadas e ative-o. " +
                        "Se o Android disser \"definição indisponível\", faça antes o passo 1)."
                )
            }
        }
        findViewById<Button>(R.id.btnBattery).setOnClickListener { openBatterySettings() }

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }
        tryAutoEnableControl()
    }

    override fun onResume() {
        super.onResume()
        persistFields()
        if (Prefs.hasSession(this)) RemoteService.start(this)
        tryAutoEnableControl()
        refreshStatus()
    }

    /**
     * When the app was granted WRITE_SECURE_SETTINGS over adb (enable-control.bat)
     * the accessibility service can be switched on by itself - no menus, and it
     * survives APK updates, which is what the Android 13+ restricted-settings
     * screen would otherwise block.
     */
    private fun tryAutoEnableControl(): Boolean {
        if (ControlService.isReady || ControlService.isEnabled(this)) return false
        if (!ControlService.enableSelf(this)) return false
        log("Controlo remoto ativado automaticamente (permissão ADB concedida).")
        return true
    }

    private fun ensureBatteryExemption() {
        if (Build.VERSION.SDK_INT < 23) return
        val prefs = Prefs.get(this)
        if (prefs.getBoolean("battery_prompted", false)) return
        val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        prefs.edit().putBoolean("battery_prompted", true).apply()
        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:$packageName")
                )
            )
            log(
                "Autorize manter a EndpointX sempre ativa - senão o Android desliga a " +
                    "ligação quando o ecrã apaga."
            )
        } catch (e: Exception) {
            log("Abra as definições de bateria e retire a otimização da EndpointX (${e.message}).")
        }
    }

    private fun openBatterySettings() {
        val prefs = Prefs.get(this)
        prefs.edit().putBoolean("battery_prompted", true).apply()
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            log(
                "Escolha \"EndpointX\" e marque Não otimizar / Sem restrições. " +
                    "Isto evita o Android matar a ligação com o ecrã desligado."
            )
        } catch (e: Exception) {
            log("Não foi possível abrir as definições de bateria: ${e.message}")
        }
        refreshStatus()
    }

    private fun persistFields() {
        Prefs.setServer(this, server.text.toString())
        if (deviceName.text.isNotEmpty()) Prefs.setDeviceName(this, deviceName.text.toString())
        Prefs.setEnrollToken(this, enrollToken.text.toString())
    }

    private fun register() {
        persistFields()
        val nameValue = deviceName.text.toString().trim()
            .ifEmpty { "${Build.MANUFACTURER} ${Build.MODEL}".trim() }
        val tokenValue = enrollToken.text.toString().trim()

        log("A registar no servidor...")
        io.execute {
            try {
                val result = EndpointApi.register(this, nameValue, tokenValue)
                runOnUiThread {
                    Prefs.setAgentId(this, result.agentId)
                    Prefs.setDeviceId(this, result.deviceId)
                    Prefs.setRemoteToken(this, result.remoteToken)
                    Prefs.setApprovalStatus(this, result.approvalStatus)
                    RemoteService.start(this)
                    ensureBatteryExemption()
                    log(
                        "Registado (${if (result.isNew) "novo" else "existente"})\n" +
                            "agent_id: ${result.agentId}\n" +
                            "estado: ${result.approvalStatus}"
                    )
                    refreshStatus()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    log("Falha no registo: ${e.message}")
                    refreshStatus()
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun requestCapture() {
        if (Prefs.agentId(this).isEmpty()) {
            log("Registe o dispositivo primeiro.")
            return
        }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    private fun stopCapture() {
        val intent = Intent(this, ShareService::class.java).setAction(ShareService.ACTION_STOP)
        try {
            startService(intent)
        } catch (e: Exception) {
            // ignore
        }
        log("Partilha de ecrã terminada.")
        refreshStatus()
    }

    @Deprecated("Deprecated in Java, still the non-AndroidX way to get the projection consent")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CAPTURE && resultCode == RESULT_OK && data != null) {
            val intent = Intent(this, ShareService::class.java)
                .setAction(ShareService.ACTION_START)
                .putExtra(ShareService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ShareService.EXTRA_RESULT_DATA, data)
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent)
                else startService(intent)
                log("Ecrã autorizado - o técnico já pode assistir a este dispositivo.")
            } catch (e: Exception) {
                log("Não foi possível iniciar a partilha: ${e.message}")
            }
        } else {
            log("Autorização de ecrã cancelada.")
        }
        refreshStatus()
    }

    /**
     * Android 13+ refuses to toggle accessibility for apps installed from an APK
     * ("Restricted setting - For your security, this setting is currently
     * unavailable"). The only supported way past it is the hidden menu in the
     * app's own info screen, so we send the user straight there.
     */
    private fun openAppDetails() {
        try {
            startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:$packageName")
                )
            )
            log(
                "Abriu a informação da app. Toque nos3 pontos (⋮) no topo e escolha " +
                    "\"Permitir definições restritas\" (confirme com PIN/impressão digital)."
            )
        } catch (e: Exception) {
            log("Não foi possível abrir as definições da app: ${e.message}")
        }
        refreshStatus()
    }

    private fun refreshStatus() {
        val registered = Prefs.hasSession(this)
        val control = ControlService.isReady
        val share = ShareService.isActive
        val agent = Prefs.agentId(this)
        val approval = Prefs.approvalStatus(this)
        val serverUrl = Prefs.server(this)
        val connection = if (Remote.connected) "ativa" else "à espera"
        val lines = buildString {
            append("versão: ").append(appVersion()).append('\n')
            append("registo: ").append(if (registered) "sim" else "não").append('\n')
            if (registered) {
                append("agent_id: ").append(agent).append('\n')
                append("estado: ").append(approval).append('\n')
                append("servidor: ").append(serverUrl).append('\n')
            }
            append("ligação: ").append(connection).append('\n')
            append("partilha de ecrã: ").append(if (share) "ativa" else "desligada").append('\n')
            append("controlo remoto: ").append(if (control) "ativo" else "desativado").append('\n')
            if (!control) {
                append("→ sem PC: botões 1) e 2) acima · com PC: enable-control.bat\n")
            }
            append("---\n")
            append(status.text)
        }
        status.text = lines
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    } catch (e: Exception) {
        ""
    }

    private fun log(message: String) {
        status.text = "[${stamp.format(Date())}] $message\n${status.text}"
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }
}
