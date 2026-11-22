package dev.tracelens

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.firestore.ListenerRegistration
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RunState(
    val id: String? = null,
    val steps: List<StepLog> = emptyList(),
    val sanitized: String = "",
    val redactions: List<Redaction> = emptyList(),
    val triage: Triage? = null,
    val analysis: String = "",
    val pending: String? = null,
    val error: String? = null,
    /** Waiting for the user to approve what leaves the device. */
    val review: Boolean = false,
)

data class UiState(
    val uid: String? = null,
    val device: DeviceStatus = DeviceStatus.UNAVAILABLE,
    val mode: ProcessingMode = ProcessingMode.HYBRID,
    val config: RoutingConfig = RoutingConfig(),
    val input: String = "",
    val run: RunState = RunState(),
    val history: List<TraceDoc> = emptyList(),
    /** null = not downloading; otherwise 0..1 (or -1 when size unknown). */
    val download: Float? = null,
    val notice: String? = null,
    val online: Boolean = true,
    val cloudLeft: Int = USER_DAILY_LIMIT,
    /** false = built-in Gemini Nano (default); true = model on a local network server. */
    val useNetwork: Boolean = false,
    val nano: NanoOption = NanoOption.STABLE,
    val lan: LanConfig = LanConfig(),
    val lanStatus: LanStatus? = null,
    val showSettings: Boolean = false,
    val crashes: List<CrashEntry>? = null,
    val crashesAllApps: Boolean = false,
    val showCrashes: Boolean = false,
    val refreshing: Boolean = false,
)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("tracelens", Context.MODE_PRIVATE)
    private val _ui = MutableStateFlow(UiState())
    val ui = _ui.asStateFlow()

    private var redactor: Redactor? = null
    private var historyReg: ListenerRegistration? = null
    private var quotaReg: ListenerRegistration? = null
    private var downloadJob: Job? = null

    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private var configLoaded = false

    /** Reconnect automatically when the network comes back. */
    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            val wasOffline = !_ui.value.online
            _ui.update { it.copy(online = true) }
            if (wasOffline || _ui.value.uid == null) refresh()
        }

        override fun onLost(network: Network) {
            _ui.update { it.copy(online = isOnline()) }
        }
    }

    private fun isOnline(): Boolean {
        val caps = connectivity?.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    init {
        _ui.update { it.copy(online = isOnline()) }
        runCatching { connectivity?.registerDefaultNetworkCallback(netCallback) }
        loadEngine()
        viewModelScope.launch {
            val device = deviceStatus()
            val saved = prefs.getString("mode", null)?.let { runCatching { ProcessingMode.valueOf(it) }.getOrNull() }
            val mode = when {
                saved == ProcessingMode.PRIVATE && device != DeviceStatus.AVAILABLE -> ProcessingMode.HYBRID
                saved != null -> saved
                device == DeviceStatus.UNAVAILABLE -> ProcessingMode.CLOUD
                else -> ProcessingMode.HYBRID
            }
            _ui.update { it.copy(device = device, mode = mode) }
        }
        refresh()
    }

    /**
     * (Re)connect: sign in, attach history, fetch Remote Config, re-check Gemini Nano.
     * Safe to call repeatedly; called on start, from the Retry button and when the network returns.
     */
    fun refresh() {
        if (_ui.value.refreshing) return
        _ui.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            try {
                _ui.update { it.copy(device = deviceStatus(), online = isOnline()) }
                if (!configLoaded) {
                    runCatching { Store.loadConfig() }.onSuccess { cfg ->
                        configLoaded = true
                        _ui.update { it.copy(config = cfg) }
                    }
                }
                if (_ui.value.uid == null) {
                    val uid = Store.ensureSignedIn()
                    _ui.update { it.copy(uid = uid) }
                }
                if (historyReg == null) {
                    _ui.value.uid?.let { uid ->
                        historyReg = Store.watch(uid) { docs -> _ui.update { it.copy(history = docs) } }
                    }
                }
                if (quotaReg == null) {
                    _ui.value.uid?.let { uid ->
                        quotaReg = Quota.watchRemaining(uid) { left -> _ui.update { it.copy(cloudLeft = left) } }
                    }
                }
                // Connected again: clear connection errors (keep analysis results).
                setRun { if (it.error != null && it.pending == null) it.copy(error = null) else it }
            } catch (e: Exception) {
                val msg = if (isOnline()) "Couldn't connect to Firebase: ${e.message}"
                else "You're offline. Turn on Wi-Fi or mobile data, then tap Retry."
                setRun { it.copy(error = msg) }
            } finally {
                _ui.update { it.copy(refreshing = false) }
            }
        }
    }

    override fun onCleared() {
        runCatching { connectivity?.unregisterNetworkCallback(netCallback) }
        historyReg?.remove()
        quotaReg?.remove()
    }

    private fun setRun(f: (RunState) -> RunState) = _ui.update { it.copy(run = f(it.run)) }

    fun setInput(v: String) = _ui.update { it.copy(input = v) }

    /* ---------------- engine settings ---------------- */

    private fun loadEngine() {
        _ui.update {
            it.copy(
                useNetwork = prefs.getBoolean("useNetwork", false),
                nano = runCatching { NanoOption.valueOf(prefs.getString("nano", "STABLE")!!) }.getOrDefault(NanoOption.STABLE),
                lan = LanConfig(
                    url = prefs.getString("lanUrl", LanConfig().url)!!,
                    model = prefs.getString("lanModel", "")!!,
                    memorySaver = prefs.getBoolean("lanMemorySaver", true),
                ),
            )
        }
        if (_ui.value.useNetwork) testLan()
    }

    fun showSettings(show: Boolean) = _ui.update { it.copy(showSettings = show) }

    fun setUseNetwork(v: Boolean) {
        prefs.edit().putBoolean("useNetwork", v).apply()
        _ui.update { it.copy(useNetwork = v) }
        if (v) testLan()
    }

    fun setNano(o: NanoOption) {
        prefs.edit().putString("nano", o.name).apply()
        resetModels()
        _ui.update { it.copy(nano = o) }
    }

    fun setLan(l: LanConfig) {
        prefs.edit().putString("lanUrl", l.url).putString("lanModel", l.model).putBoolean("lanMemorySaver", l.memorySaver).apply()
        _ui.update { it.copy(lan = l) }
    }

    private var lanJob: Job? = null

    /** Check the server now, then keep its Online/Offline status fresh every 15 s. */
    fun testLan() {
        lanJob?.cancel()
        lanJob = viewModelScope.launch {
            while (true) {
                val st = Lan.status(_ui.value.lan.url)
                _ui.update { s ->
                    val model = if (s.lan.model.isEmpty() && st.online) st.models.firstOrNull()?.name.orEmpty() else s.lan.model
                    s.copy(lanStatus = st, lan = s.lan.copy(model = model))
                }
                if (!_ui.value.useNetwork) break
                kotlinx.coroutines.delay(15_000)
            }
        }
    }

    private fun engine(): Engine {
        val s = _ui.value
        return if (s.useNetwork && s.lanStatus?.online == true && s.lan.model.isNotEmpty()) Engine.Network(s.lan)
        else Engine.Builtin(s.nano)
    }

    /* ---------------- debug installed apps ---------------- */

    fun loadCrashes() {
        val ctx = getApplication<Application>()
        _ui.update { it.copy(showCrashes = true, crashes = null, crashesAllApps = Crashes.canReadAllApps(ctx)) }
        viewModelScope.launch {
            val list = runCatching { Crashes.recent() }.getOrDefault(emptyList())
            _ui.update { it.copy(crashes = list) }
        }
    }

    fun hideCrashes() = _ui.update { it.copy(showCrashes = false) }

    fun pickCrash(c: CrashEntry) = _ui.update { it.copy(input = c.text, showCrashes = false) }

    fun setMode(m: ProcessingMode) {
        prefs.edit().putString("mode", m.name).apply()
        _ui.update { it.copy(mode = m) }
    }

    /* ---------------- on-device model download ---------------- */

    fun startDownload() {
        downloadJob?.cancel()
        _ui.update { it.copy(download = 0f, notice = null) }
        downloadJob = viewModelScope.launch {
            downloadModel()
                .catch { e -> _ui.update { it.copy(download = null, notice = "Download failed: ${e.message}") } }
                .collect { ev ->
                    when (ev) {
                        is DownloadEvent.Progress -> _ui.update {
                            it.copy(download = if (ev.total > 0) ev.downloaded.toFloat() / ev.total else -1f)
                        }
                        DownloadEvent.Done -> {
                            resetModels()
                            _ui.update {
                                it.copy(download = null, device = deviceStatus(), mode = ProcessingMode.HYBRID,
                                    notice = "Gemini Nano is ready. Redaction and triage now run on this device.")
                            }
                        }
                        is DownloadEvent.Failed -> _ui.update { it.copy(download = null, notice = "Download failed: ${ev.message}") }
                    }
                }
        }
    }

    fun cancelDownload() {
        downloadJob?.cancel()
        _ui.update { it.copy(download = null, notice = "Download cancelled.") }
    }

    /* ---------------- pipeline ---------------- */

    fun analyze() {
        val s = _ui.value
        if (s.uid == null || s.run.pending != null) return
        val raw = s.input.trim()
        _ui.update { it.copy(run = RunState(pending = "Starting…")) }
        viewModelScope.launch {
            try {
                val dev = deviceStatus()
                _ui.update { it.copy(device = dev) }
                val mode = _ui.value.mode
                val eng = engine()
                if (_ui.value.useNetwork && eng !is Engine.Network && mode != ProcessingMode.CLOUD) {
                    error(
                        if (_ui.value.lanStatus?.online == false) "Your local network server (${_ui.value.lan.url}) is offline. Start it, switch to Built-in in Settings, or use Cloud mode."
                        else "Pick a model for your local network server in Settings.",
                    )
                }
                if (mode == ProcessingMode.PRIVATE && dev != DeviceStatus.AVAILABLE && eng !is Engine.Network) {
                    error("Private mode needs Gemini Nano on this device. Switch to Hybrid or Cloud mode.")
                }
                require(raw.isNotEmpty()) { "Paste a stack trace or log first." }
                require(looksLikeError(raw)) {
                    "That doesn't look like an error, stack trace or log. Paste the failing output (or try a sample)."
                }
                val nano = (dev == DeviceStatus.AVAILABLE || eng is Engine.Network) && mode != ProcessingMode.CLOUD
                setRun { it.copy(pending = if (nano) "Redacting on-device…" else "Redacting with local rules…") }
                val red = redact(raw, dev, mode, _ui.value.config, eng)
                redactor = red.redactor
                setRun { it.copy(sanitized = red.sanitized, redactions = red.redactor.redactions, steps = red.logs) }

                if (!nano || !red.modelRan) {
                    if (mode == ProcessingMode.PRIVATE) error("Gemini Nano couldn't redact this trace, and Private mode never uses the cloud.")
                    // Only rules ran and the next step may be the cloud: let the user check first.
                    setRun { it.copy(pending = null, review = true) }
                    return@launch
                }
                triageAndSave()
            } catch (e: Exception) {
                setRun { it.copy(pending = null, error = e.message ?: e.toString()) }
            }
        }
    }

    fun approveAndSend() {
        viewModelScope.launch { triageAndSave() }
    }

    fun cancelReview() = setRun { RunState() }

    /** Review step: hide the selected text everywhere in the sanitized trace. */
    fun hide(value: String) {
        val r = redactor ?: return
        setRun { it.copy(sanitized = r.applyLiterals(it.sanitized, listOf("HIDDEN" to value), by = "user"), redactions = r.redactions) }
    }

    private suspend fun triageAndSave() {
        val uid = _ui.value.uid ?: return
        try {
            setRun { it.copy(review = false, error = null, pending = "Triaging…") }
            val run = _ui.value.run
            val s = _ui.value
            // Count cloud calls only; Gemini Nano is free and unmetered.
            val eng = engine()
            val cloudPlanned = if (eng is Engine.Network && s.mode != ProcessingMode.CLOUD) false
            else s.mode == ProcessingMode.CLOUD || s.device != DeviceStatus.AVAILABLE ||
                run.sanitized.length > minOf(s.config.maxOnDeviceChars, 9_000)
            if (cloudPlanned) Quota.consume(uid)
            val (tri, log) = triage(run.sanitized, _ui.value.config, _ui.value.mode, eng)
            // Hybrid may still fall back to the cloud if Nano fails: count it afterwards.
            if (!cloudPlanned && log.source == StepSource.IN_CLOUD) runCatching { Quota.consume(uid) }
            val steps = run.steps + log
            setRun { it.copy(steps = steps, pending = null) }
            if (!tri.isError) error("The model didn't find an error in this input, so nothing was saved.")
            setRun { it.copy(triage = tri) }
            val id = Store.save(uid, run.sanitized, tri, steps, run.redactions)
            setRun { it.copy(id = id) }
            val cfg = _ui.value.config
            if (_ui.value.mode != ProcessingMode.PRIVATE && cfg.autoEscalate && tri.confidence < cfg.escalateBelowConfidence) {
                deepDiveNow()
            }
        } catch (e: Exception) {
            setRun { it.copy(pending = null, error = e.message ?: e.toString()) }
        }
    }

    fun deepDive() {
        viewModelScope.launch { deepDiveNow() }
    }

    private suspend fun deepDiveNow() {
        val eng = engine()
        val viaLan = eng is Engine.Network && _ui.value.mode == ProcessingMode.PRIVATE
        if (_ui.value.mode == ProcessingMode.PRIVATE && !viaLan) {
            setRun { it.copy(error = "Private mode: nothing is sent to the cloud. Switch to Hybrid, or use a local network server for a private deep dive.") }
            return
        }
        val run = _ui.value.run
        setRun {
            it.copy(
                pending = if (viaLan) "Deep dive on your network (${_ui.value.lan.model})…" else "Deep dive in the cloud (sanitized trace only)…",
                analysis = "", error = null,
            )
        }
        val t = System.currentTimeMillis()
        try {
            if (!viaLan) _ui.value.uid?.let { Quota.consume(it) }
            var text = ""
            deepDive(run.sanitized, run.triage, _ui.value.config, (eng as? Engine.Network)?.lan?.takeIf { viaLan }).collect { acc ->
                text = acc
                setRun { it.copy(analysis = acc) }
            }
            val steps = run.steps.filter { it.step != "Root-cause deep dive" } +
                StepLog("Root-cause deep dive", if (viaLan) StepSource.LOCAL_NETWORK else StepSource.IN_CLOUD, System.currentTimeMillis() - t)
            setRun { it.copy(steps = steps, pending = null) }
            val uid = _ui.value.uid
            val id = _ui.value.run.id
            if (uid != null && id != null) Store.saveAnalysis(uid, id, text, steps)
        } catch (e: Exception) {
            setRun { it.copy(pending = null, error = "Deep dive failed: ${e.message}") }
        }
    }

    fun open(doc: TraceDoc) = setRun {
        RunState(id = doc.id, steps = doc.steps, sanitized = doc.sanitized, triage = doc.triage, analysis = doc.analysis.orEmpty())
    }

    fun delete(doc: TraceDoc) {
        _ui.value.uid?.let { Store.delete(it, doc.id) }
    }
}
