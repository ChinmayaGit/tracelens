package dev.tracelens

import android.app.ActivityManager
import android.content.Context
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.coroutineContext

/**
 * Google AI Edge models: the same LiteRT/MediaPipe runtime the "AI Edge Gallery" app uses.
 * Runs open models fully on the phone, so phones WITHOUT Gemini Nano/AICore still get
 * private on-device AI. Models are downloaded once into app storage.
 */
data class EdgeModel(
    val id: String,
    val name: String,
    val repo: String,
    val file: String,
    val sizeGb: Double,
    val minRamGb: Int,
    /** Gemma models are gated on Hugging Face: accept the license and paste a read token. */
    val needsToken: Boolean,
    val note: String,
    val shortName: String = name.substringBefore(" ("),
) {
    val url get() = "https://huggingface.co/$repo/resolve/main/$file"
}

val EDGE_MODELS = listOf(
    EdgeModel("gemma3-1b", "Gemma 3 1B (int4)", "litert-community/Gemma3-1B-IT", "gemma3-1b-it-int4.task",
        0.55, 3, true, "Smallest & fastest. Good for redaction.", "Gemma 3 1B"),
    EdgeModel("qwen2.5-1.5b", "Qwen 2.5 1.5B Instruct", "litert-community/Qwen2.5-1.5B-Instruct",
        "Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.task", 1.6, 4, false, "Best default: free, solid JSON output.", "Qwen 2.5"),
    EdgeModel("gemma3n-e2b", "Gemma 3n E2B (int4)", "google/gemma-3n-E2B-it-litert-preview", "gemma-3n-E2B-it-int4.task",
        3.14, 6, true, "Strongest Gemma for phones (AI Edge Gallery's headline model).", "Gemma 3n"),
    EdgeModel("phi4-mini", "Phi-4-mini Instruct", "litert-community/Phi-4-mini-instruct",
        "Phi-4-mini-instruct_multi-prefill-seq_q8_ekv4096.task", 3.91, 8, false, "Best reasoning; needs a flagship phone.", "Phi-4-mini"),
)

object Edge {
    private var loaded: Pair<String, LlmInference>? = null

    fun dir(ctx: Context) = File(ctx.filesDir, "models").apply { mkdirs() }
    fun fileFor(ctx: Context, m: EdgeModel) = File(dir(ctx), m.file)
    fun isInstalled(ctx: Context, m: EdgeModel) = fileFor(ctx, m).let { it.exists() && it.length() > 0 }

    fun deviceRamGb(ctx: Context): Double {
        val mi = ActivityManager.MemoryInfo()
        ctx.getSystemService(ActivityManager::class.java).getMemoryInfo(mi)
        return mi.totalMem / 1e9
    }

    /** Resumable download with progress (0..1). Gated models need a Hugging Face token. */
    suspend fun download(ctx: Context, m: EdgeModel, hfToken: String, onProgress: (Float) -> Unit) = withContext(Dispatchers.IO) {
        val dest = fileFor(ctx, m)
        val part = File(dest.path + ".part")
        val c = (URL(m.url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15_000
            readTimeout = 60_000
            if (hfToken.isNotBlank()) setRequestProperty("Authorization", "Bearer ${hfToken.trim()}")
            if (part.exists()) setRequestProperty("Range", "bytes=${part.length()}-")
        }
        when (c.responseCode) {
            200, 206 -> Unit
            401, 403 -> throw Exception(
                if (m.needsToken) "${m.name} is gated: accept the license on huggingface.co/${m.repo} and paste a read token in Settings."
                else "Download refused (${c.responseCode}).",
            )
            else -> throw Exception("Download failed: HTTP ${c.responseCode}")
        }
        val resumed = c.responseCode == 206
        if (!resumed) part.delete()
        val total = (if (resumed) part.length() else 0L) + c.contentLengthLong
        var done = if (resumed) part.length() else 0L
        c.inputStream.use { input ->
            java.io.FileOutputStream(part, resumed).use { out ->
                val buf = ByteArray(1 shl 16)
                var lastReport = 0L
                while (true) {
                    coroutineContext.ensureActive()
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    if (done - lastReport > 4_000_000) {
                        lastReport = done
                        onProgress(if (total > 0) done.toFloat() / total else 0f)
                    }
                }
            }
        }
        part.renameTo(dest)
        onProgress(1f)
    }

    fun delete(ctx: Context, m: EdgeModel) {
        if (loaded?.first == m.id) { loaded?.second?.close(); loaded = null }
        fileFor(ctx, m).delete()
        File(fileFor(ctx, m).path + ".part").delete()
    }

    /** Load once and keep it; switching models frees the previous one. GPU first, CPU fallback. */
    private fun engine(ctx: Context, m: EdgeModel): LlmInference = synchronized(this) {
        loaded?.takeIf { it.first == m.id }?.let { return it.second }
        loaded?.second?.close()
        loaded = null
        fun build(backend: LlmInference.Backend) = LlmInference.createFromOptions(
            ctx,
            LlmInference.LlmInferenceOptions.builder()
                .setModelPath(fileFor(ctx, m).absolutePath)
                .setMaxTokens(4096)
                .setPreferredBackend(backend)
                .build(),
        )
        val inst = runCatching { build(LlmInference.Backend.GPU) }.getOrElse { build(LlmInference.Backend.CPU) }
        loaded = m.id to inst
        inst
    }

    suspend fun generate(ctx: Context, m: EdgeModel, prompt: String): String = withContext(Dispatchers.Default) {
        engine(ctx, m).generateResponse(prompt)
    }

    /** Streams accumulated text. */
    fun stream(ctx: Context, m: EdgeModel, prompt: String): Flow<String> = callbackFlow {
        val sb = StringBuilder()
        val llm = withContext(Dispatchers.Default) { engine(ctx, m) }
        llm.generateResponseAsync(prompt) { partial, done ->
            sb.append(partial)
            trySend(sb.toString())
            if (done) close()
        }
        awaitClose { }
    }
}
