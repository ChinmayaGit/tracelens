package dev.tracelens

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Debug your installed apps: read recent crashes of ANY app from the system crash
 * log buffer. Android only lets apps read other apps' logs with READ_LOGS, a
 * development permission that can be granted once from a computer:
 *
 *   adb shell pm grant dev.tracelens android.permission.READ_LOGS
 */
data class CrashEntry(val app: String, val exception: String, val time: String, val text: String)

object Crashes {
    const val GRANT_COMMAND = "adb shell pm grant dev.tracelens android.permission.READ_LOGS"

    fun canReadAllApps(ctx: Context) =
        ctx.checkSelfPermission(Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED

    suspend fun recent(limit: Int = 20): List<CrashEntry> = withContext(Dispatchers.IO) {
        val proc = ProcessBuilder("logcat", "-b", "crash", "-d", "-v", "time", "-t", "2000")
            .redirectErrorStream(true).start()
        val lines = proc.inputStream.bufferedReader().readLines()
        proc.waitFor()

        // Group lines by crash: each starts at "FATAL EXCEPTION" (Java/Kotlin) or "*** ***" (native).
        val crashes = mutableListOf<MutableList<String>>()
        for (line in lines) {
            if (line.startsWith("---------")) continue
            val msg = line.substringAfter("): ", line)
            if (msg.startsWith("FATAL EXCEPTION") || msg.startsWith("*** *** ***")) crashes.add(mutableListOf())
            crashes.lastOrNull()?.add(line)
        }
        crashes.takeLast(limit).reversed().map { block ->
            val body = block.map { it.substringAfter("): ", it) }
            val app = body.firstOrNull { it.startsWith("Process: ") }?.removePrefix("Process: ")?.substringBefore(",")
                ?: body.firstOrNull { it.startsWith("Cmdline: ") }?.removePrefix("Cmdline: ")
                ?: "unknown app"
            val ex = body.firstOrNull { it.contains("Exception") || it.contains("Error") || it.startsWith("signal") }
                ?.take(140) ?: body.getOrNull(1).orEmpty().take(140)
            CrashEntry(app, ex, block.first().take(18), body.joinToString("\n"))
        }
    }
}
