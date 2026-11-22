package dev.tracelens

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Local-network inference: a more powerful machine on your Wi-Fi (Ollama) does the
 * work. Data never leaves your network, so it's treated like on-device.
 *
 * On the server:  OLLAMA_HOST=0.0.0.0 ollama serve   (then: ollama pull qwen2.5-coder:7b)
 */
data class LanConfig(
    val url: String = "http://192.168.1.10:11434",
    val model: String = "",
    /** Memory-map weights from disk, smaller context, unload after 1 min idle. */
    val memorySaver: Boolean = true,
)

data class LanModel(val name: String, val params: String, val sizeGb: Double, val minRamGb: Int)

data class LanStatus(val online: Boolean, val models: List<LanModel> = emptyList(), val error: String? = null)

val RECOMMENDED_LAN_MODELS = listOf(
    Triple("llama3.2:3b", 4, "fast, fine for triage on laptops"),
    Triple("gemma3:4b", 6, "good all-rounder"),
    Triple("qwen2.5-coder:7b", 8, "best code reasoning per GB"),
    Triple("gemma3:12b", 12, "stronger root-cause analysis"),
    Triple("qwen2.5-coder:32b", 24, "near-cloud quality; desktop GPU / 32 GB Mac"),
)

object Lan {
    private fun base(url: String) = url.trim().trimEnd('/')

    suspend fun status(url: String): LanStatus = withContext(Dispatchers.IO) {
        try {
            val c = (URL("${base(url)}/api/tags").openConnection() as HttpURLConnection).apply {
                connectTimeout = 2500
                readTimeout = 2500
            }
            if (c.responseCode != 200) return@withContext LanStatus(false, error = "HTTP ${c.responseCode}")
            val arr = JSONObject(c.inputStream.bufferedReader().readText()).optJSONArray("models") ?: JSONArray()
            LanStatus(true, (0 until arr.length()).map { i ->
                val m = arr.getJSONObject(i)
                val size = m.optLong("size")
                LanModel(
                    name = m.optString("name"),
                    params = m.optJSONObject("details")?.optString("parameter_size").orEmpty(),
                    sizeGb = Math.round(size / 1e8) / 10.0,
                    minRamGb = Math.ceil(size / 1e9 + 1.5).toInt(),
                )
            })
        } catch (e: Exception) {
            LanStatus(false, error = e.message ?: "unreachable")
        }
    }

    private fun body(cfg: LanConfig, system: String, prompt: String, stream: Boolean, schema: JSONObject?) =
        JSONObject().apply {
            put("model", cfg.model)
            put("stream", stream)
            put("messages", JSONArray().put(JSONObject().put("role", "system").put("content", system))
                .put(JSONObject().put("role", "user").put("content", prompt)))
            schema?.let { put("format", it) }
            put("keep_alive", if (cfg.memorySaver) "1m" else "15m")
            put("options", JSONObject().apply {
                put("use_mmap", true)
                put("use_mlock", !cfg.memorySaver)
                put("num_ctx", if (cfg.memorySaver) 4096 else 8192)
            })
        }.toString()

    private fun open(cfg: LanConfig, payload: String, readTimeoutMs: Int): HttpURLConnection {
        val c = try {
            (URL("${base(cfg.url)}/api/chat").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 4000
                readTimeout = readTimeoutMs
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(payload.toByteArray()) }
            }
        } catch (e: Exception) {
            throw Exception("Local server ${cfg.url} is offline or unreachable. Check it's running and on the same Wi-Fi.")
        }
        if (c.responseCode != 200) {
            throw Exception("Local server error ${c.responseCode}: ${c.errorStream?.bufferedReader()?.readText()?.take(200)}")
        }
        return c
    }

    suspend fun chat(cfg: LanConfig, system: String, prompt: String, schema: JSONObject? = null): String =
        withContext(Dispatchers.IO) {
            val c = open(cfg, body(cfg, system, prompt, false, schema), 180_000)
            JSONObject(c.inputStream.bufferedReader().readText()).optJSONObject("message")?.optString("content").orEmpty()
        }

    /** Streams accumulated text. */
    fun stream(cfg: LanConfig, system: String, prompt: String): Flow<String> = flow {
        val c = open(cfg, body(cfg, system, prompt, true, null), 300_000)
        val sb = StringBuilder()
        c.inputStream.bufferedReader().useLines { lines ->
            for (line in lines) {
                if (line.isBlank()) continue
                sb.append(JSONObject(line).optJSONObject("message")?.optString("content").orEmpty())
                emit(sb.toString())
            }
        }
    }.flowOn(Dispatchers.IO)
}
